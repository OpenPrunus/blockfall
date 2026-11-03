<?php

declare(strict_types=1);

namespace Blockfall\Tests\Game;

use Arcade\Support\StdoutLogger;
use Blockfall\Game\Client;
use Blockfall\Game\ClientStatus;
use Blockfall\Game\GameHub;
use Blockfall\Game\HubConfig;
use Blockfall\Ranking\RankingStore;
use Blockfall\Tests\Game\Support\FakeTransport;
use Blockfall\Tests\Game\Support\MutableClock;
use PHPUnit\Framework\TestCase;
use Random\Engine\Mt19937;
use Random\Randomizer;

/** Le serveur de jeu sans réseau : salon, défis, partie rapide, compte à rebours, images du duel, résultat, forfaits et revanches. */
final class GameHubTest extends TestCase
{
    private GameHub $hub;
    private MutableClock $clock;
    private string $dir;
    private int $ipCounter = 0;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/blockfall-hub-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->clock = new MutableClock();
        $this->hub = $this->makeHub();
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->dir . '/*') ?: []);
        rmdir($this->dir);
    }

    private function makeHub(int $countdown = 1): GameHub
    {
        $silent = new StdoutLogger(fopen('php://memory', 'w'));

        return GameHub::create(new HubConfig(countdown: $countdown), new RankingStore($this->dir . '/ratings.json'), $this->clock, $silent, new Randomizer(new Mt19937(7)));
    }

    /** @return array{Client, FakeTransport} */
    private function connect(?string $name = null, ?string $token = null, ?string $ip = null): array
    {
        $transport = new FakeTransport();
        $client = $this->hub->accept($transport);
        $client->setAddress($ip ?? '203.0.113.' . (++$this->ipCounter));        // une adresse différente par navigateur, sauf demande contraire
        if ($name !== null) {
            $this->say($client, ['t' => 'hello', 'name' => $name, 'token' => $token]);
        }

        return [$client, $transport];
    }

    /** @param array<string, mixed> $msg */
    private function say(Client $client, array $msg): void
    {
        $this->hub->receive($client, json_encode($msg, JSON_THROW_ON_ERROR));
    }

    private function ticks(int $n): void
    {
        for ($i = 0; $i < $n; $i++) {
            $this->hub->tick();
        }
    }

    private static function token(string $seed): string
    {
        return substr(str_repeat($seed, 30), 0, 32);
    }

    /** @return array{Client, FakeTransport, Client, FakeTransport} deux joueurs en match (jetons différents => classé), compte à rebours en cours */
    private function startRankedMatch(string $a = 'Alice', string $b = 'Bob'): array
    {
        [$ca, $ta] = $this->connect($a, self::token($a));
        [$cb, $tb] = $this->connect($b, self::token($b));
        $this->say($ca, ['t' => 'queue']);
        $this->say($cb, ['t' => 'queue']);

        return [$ca, $ta, $cb, $tb];
    }

    /** Attend la fin du compte à rebours (1 s). */
    private function untilGo(): void
    {
        $this->ticks(61);
    }

    /** Le joueur « a » empile tout au centre jusqu'à perdre. */
    private function loseByStacking(Client $loser): void
    {
        for ($i = 0; $i < 60 && $loser->room?->finished === false; $i++) {
            $this->say($loser, ['t' => 'act', 'a' => 'hd']);
            $this->ticks(12);
        }
    }

    public function testHelloRegistersThePlayerAndAnnouncesTheLobby(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('  Bob  ');
        $this->assertSame('Alice', $ta->last('welcome')['name']);
        $this->assertSame('Bob', $tb->last('welcome')['name'], 'espaces retirés');
        $this->assertFalse($ta->last('welcome')['ranked'], 'sans jeton : invité');
        $this->assertSame(ClientStatus::Lobby, $a->status);
        $this->ticks(GameHub::HOUSEKEEPING_EVERY);
        $this->assertSame(['Bob'], array_column($ta->last('lobby')['players'], 'name'), 'chacun voit les autres, pas lui-même');
        $this->assertSame(['Alice'], array_column($tb->last('lobby')['players'], 'name'));
    }

    public function testInvalidAndDuplicateNicknamesAreRefused(): void
    {
        foreach (['', '   ', '<>!?', null] as $bad) {
            [, $t] = $this->connect($bad ?? '');
            $this->assertSame('bad_name', $t->last('error')['code'] ?? null, var_export($bad, true));
        }
        $this->connect('Alice');
        [, $t] = $this->connect('ALICE');
        $this->assertSame('name_taken', $t->last('error')['code'], 'pseudo déjà connecté, sans tenir compte de la casse');
        [, $long] = $this->connect(str_repeat('x', 40));
        $this->assertSame(15, mb_strlen($long->last('welcome')['name']));
    }

    public function testEverythingButPingAndHelloNeedsANickname(): void
    {
        [$c, $t] = $this->connect();
        $this->say($c, ['t' => 'queue']);
        $this->say($c, ['t' => 'challenge', 'id' => 1]);
        $this->assertSame(['error', 'error'], $t->types());
        $this->assertSame('not_ready', $t->last('error')['code']);
        $this->say($c, ['t' => 'ping', 'c' => 5]);
        $this->assertSame(5, $t->last('pong')['c']);
    }

    public function testLeavingTheQueueAndQueueingTwiceDoNotMatchAPlayerWithHimself(): void
    {
        [$a, $ta] = $this->connect('Alice');
        $this->say($a, ['t' => 'queue']);
        $this->say($a, ['t' => 'queue']);
        $this->assertSame('busy', $ta->last('error')['code']);
        $this->say($a, ['t' => 'unqueue']);
        $this->assertNotNull($ta->last('unqueued'));
        [$b, $tb] = $this->connect('Bob');
        $this->say($b, ['t' => 'queue']);
        $this->assertNull($tb->last('match'), 'Alice a quitté la file');
        $this->assertSame(0, $this->hub->matchCount());
    }

    public function testChallengeAcceptStartsAMatch(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->assertSame('Bob', $ta->last('waiting')['name']);
        $this->assertSame(['id' => $a->id, 'name' => 'Alice'], array_intersect_key($tb->last('invite'), ['id' => 1, 'name' => 1]));
        $this->say($b, ['t' => 'accept', 'id' => $a->id]);
        $this->assertNotNull($ta->last('match'));
        $this->assertNotNull($tb->last('match'));
        $this->assertNull($a->invite);
    }

    public function testDeclineCancelAndInvalidAnswers(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        [$c, $tc] = $this->connect('Carl');
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->say($c, ['t' => 'accept', 'id' => $a->id]);
        $this->assertSame('busy', $tc->last('error')['code'], 'seul le défié peut accepter');
        $this->say($b, ['t' => 'accept', 'id' => 999]);
        $this->assertSame('busy', $tb->last('error')['code'], 'mauvais défieur');
        $this->say($b, ['t' => 'decline', 'id' => $a->id]);
        $this->assertSame('Bob', $ta->last('declined')['name']);
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->say($a, ['t' => 'cancel']);
        $this->assertNotNull($tb->last('invite_cancel'));
        $this->say($b, ['t' => 'accept', 'id' => $a->id]);
        $this->assertNull($tb->last('match'), 'défi retiré : plus rien à accepter');
    }

    public function testChallengeRefusedWhenTheTargetIsBusyOrInvalid(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b] = $this->connect('Bob');
        [$c, $tc] = $this->connect('Carl');
        $this->say($a, ['t' => 'challenge', 'id' => $a->id]);
        $this->say($a, ['t' => 'challenge', 'id' => 4242]);
        $this->say($a, ['t' => 'challenge', 'id' => 'x']);
        $this->assertSame(['busy', 'busy', 'busy'], array_column($ta->of('error'), 'code'));
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->say($c, ['t' => 'challenge', 'id' => $b->id]);
        $this->assertSame('busy', $tc->last('error')['code'], 'Bob a déjà un défi en attente');
    }

    public function testExpiredInvitationsAreCancelledForBothSides(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        $this->say($a, ['t' => 'challenge', 'id' => $b->id]);
        $this->clock->advance(21);
        $this->ticks(GameHub::HOUSEKEEPING_EVERY);
        $this->assertNotNull($ta->last('invite_cancel'));
        $this->assertNotNull($tb->last('invite_cancel'));
        $this->assertNull($a->invite);
    }

    public function testTwoTabsOfTheSameBrowserNeverRankAgainstEachOther(): void
    {
        $same = self::token('z');
        [$a, $ta] = $this->connect('Tab1', $same);
        [$b] = $this->connect('Tab2', $same);
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertFalse($ta->last('match')['ranked']);
    }

    public function testReservedNicknamesBelongToTheirToken(): void
    {
        [$a, , $b] = $this->startRankedMatch();
        $this->untilGo();
        $this->loseByStacking($a);
        $this->say($a, ['t' => 'leave']);
        $this->say($b, ['t' => 'leave']);
        $this->hub->disconnect($a);
        $this->hub->disconnect($b);
        [, $t] = $this->connect('Alice', self::token('x'));
        $this->assertSame('name_taken', $t->last('error')['code'], 'un autre jeton ne peut pas prendre Alice');
        [, $g] = $this->connect('Alice');
        $this->assertSame('name_taken', $g->last('error')['code'], 'ni un invité sans jeton');
        [, $ok] = $this->connect('Alice', self::token('Alice'));
        $this->assertNotNull($ok->last('welcome'), 'le propriétaire revient avec son jeton');
        $this->assertNotNull($ok->last('welcome')['rating']);
    }


    public function testQuickMatchPairsTwoPlayersOnOppositeBoardsAndStartsACountdown(): void
    {
        [$a, $ta] = $this->connect('Alice');
        [$b, $tb] = $this->connect('Bob');
        $this->say($a, ['t' => 'queue']);
        $this->assertNotNull($ta->last('queued'));
        $this->assertSame(ClientStatus::Queued, $a->status);
        $this->say($b, ['t' => 'queue']);
        $ma = $ta->last('match');
        $mb = $tb->last('match');
        $this->assertNotNull($ma);
        $this->assertNotNull($mb);
        $this->assertSame(1, $ma['side'] + $mb['side'], 'un plateau chacun');
        $this->assertSame('Bob', $ma['opp']['name']);
        $this->assertSame('Alice', $mb['opp']['name']);
        $this->assertFalse($ma['ranked'], 'invités : amical');
        $this->assertSame(1, $ta->last('cd')['n'], 'compte à rebours annoncé');
        $this->assertSame([ClientStatus::Playing, ClientStatus::Playing], [$a->status, $b->status]);
        $this->assertSame(1, $this->hub->matchCount());
        $this->assertNull($ta->last('s'), 'pas d\'état avant le départ');
    }

    public function testTheGameStartsAfterTheCountdownWithTheFullStateOfBothBoards(): void
    {
        [, $ta, , $tb] = $this->startRankedMatch();
        $this->ticks(59);
        $this->assertNull($ta->last('go'));
        $this->ticks(2);
        $this->assertNotNull($ta->last('go'));
        $s = $ta->last('s');
        $this->assertNotNull($s, 'état complet au départ');
        $this->assertSame($s, $tb->last('s'), 'les deux joueurs reçoivent le même état');
        $this->assertCount(2, $s['b']);
        foreach ($s['b'] as $board) {
            $this->assertSame(200, strlen($board['g']), 'grille visible : 20 rangées de 10');
            $this->assertCount(5, $board['q']);
            $this->assertSame(-1, $board['h']);
            $this->assertTrue($board['al']);
        }
        $this->assertSame($s['b'][0]['q'], $s['b'][1]['q'], 'même suite de pièces');
    }

    public function testKeysAndActionsMoveThePlayersOwnPieceAndOnlyChangesAreSent(): void
    {
        [$a, $ta, , $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->ticks(20);                                          // la première pièce est apparue
        $me = $ta->last('match')['side'];
        $pieceBefore = null;
        foreach (array_reverse($tb->of('s')) as $m) {
            if (isset($m['b'][$me]['p'])) {
                $pieceBefore = $m['b'][$me]['p'];
                break;
            }
        }
        $this->assertNotNull($pieceBefore);
        $this->say($a, ['t' => 'keys', 'l' => true, 'r' => false, 'd' => false]);
        $this->ticks(1);
        $this->say($a, ['t' => 'keys', 'l' => false, 'r' => false, 'd' => false]);
        $this->say($a, ['t' => 'act', 'a' => 'cw']);
        $this->ticks(1);
        $latest = null;
        foreach (array_reverse($tb->of('s')) as $m) {
            if (isset($m['b'][$me]['p'])) {
                $latest = $m['b'][$me]['p'];
                break;
            }
        }
        $this->assertNotNull($latest);
        $this->assertSame($pieceBefore[2] - 1, $latest[2], 'un pas à gauche');
        $this->assertSame(($pieceBefore[1] + 1) % 4, $latest[1], 'rotation horaire');
        $count = count($tb->of('s'));
        $this->ticks(1);
        $last = $tb->last('s');
        $this->assertArrayNotHasKey('g', $last['b'][0], 'la grille n\'est pas renvoyée tant qu\'elle ne change pas');
        $this->assertGreaterThanOrEqual($count, count($tb->of('s')));
    }

    public function testAKeyPressedAndReleasedBetweenTwoFramesStillMovesThePieceOnce(): void
    {
        [$a, $ta, , $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->ticks(20);
        $me = $ta->last('match')['side'];
        $lastPiece = static function (FakeTransport $t) use ($me): ?array {
            foreach (array_reverse($t->of('s')) as $m) {
                if (isset($m['b'][$me]['p'])) {
                    return $m['b'][$me]['p'];
                }
            }

            return null;
        };
        $before = $lastPiece($tb);
        $this->say($a, ['t' => 'keys', 'l' => true, 'r' => false, 'd' => false]);
        $this->say($a, ['t' => 'keys', 'l' => false, 'r' => false, 'd' => false]);     // relâchée avant la prochaine image
        $this->ticks(2);
        $after = $lastPiece($tb);
        $this->assertNotNull($before);
        $this->assertSame($before[2] - 1, $after[2], 'un appui très court compte quand même');
    }

    public function testSideStepActionsMoveThePieceOneCellEachEvenSeveralInTheSameFrame(): void
    {
        [$a, $ta, , $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->ticks(20);
        $me = $ta->last('match')['side'];
        $x = static function (FakeTransport $t) use ($me): ?int {
            foreach (array_reverse($t->of('s')) as $m) {
                if (isset($m['b'][$me]['p'])) {
                    return $m['b'][$me]['p'][2];
                }
            }

            return null;
        };
        $before = $x($tb);
        $this->say($a, ['t' => 'act', 'a' => 'left']);
        $this->say($a, ['t' => 'act', 'a' => 'left']);
        $this->say($a, ['t' => 'act', 'a' => 'left']);
        $this->ticks(2);
        $this->assertSame($before - 3, $x($tb), 'trois pas à gauche');
        $this->say($a, ['t' => 'act', 'a' => 'right']);
        $this->ticks(2);
        $this->assertSame($before - 2, $x($tb));
    }

    public function testInvalidInputIsRefusedOrIgnored(): void
    {
        [$a, $ta, $b] = $this->startRankedMatch();
        $this->untilGo();
        $this->say($a, ['t' => 'act', 'a' => 'banana']);
        $this->assertSame('bad_action', $ta->last('error')['code']);
        $this->say($a, ['t' => 'act']);
        $this->assertSame(2, count($ta->of('error')));
        [$c, $tc] = $this->connect('Carl');
        $before = count($tc->sent);
        $this->say($c, ['t' => 'act', 'a' => 'hd']);
        $this->say($c, ['t' => 'keys', 'l' => true]);
        $this->assertCount($before, $tc->sent, 'sans match : ignoré');
    }

    public function testMessageRateIsLimitedPerSecond(): void
    {
        [$a, $ta] = $this->connect('Alice');
        for ($i = 0; $i < 400; $i++) {
            $this->say($a, ['t' => 'ping', 'c' => $i]);
        }
        $this->assertCount(120 - 1, $ta->of('pong'), 'hello compte aussi dans la seconde');
        $this->clock->advance(1);
        $this->say($a, ['t' => 'ping', 'c' => 1]);
        $this->assertCount(120, $ta->of('pong'), 'la seconde suivante repart de zéro');
    }

    public function testTheBoardThatFillsUpLosesAndTheResultUpdatesTheRating(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->assertTrue($ta->last('match')['ranked']);
        $this->loseByStacking($a);
        $ra = $ta->last('result');
        $rb = $tb->last('result');
        $this->assertNotNull($ra, 'résultat annoncé');
        $this->assertFalse($ra['forfeit']);
        $myBoard = $ta->last('match')['side'];
        $this->assertSame(1 - $myBoard, $ra['winner'], 'celui qui empile perd');
        $this->assertSame($ra['winner'], $rb['winner']);
        $this->assertSame(1000 + $ra['delta'], $ra['rating']);
        $this->assertSame(0, $ra['delta'] + $rb['delta']);
        $this->assertLessThan(0, $ra['delta']);
        $ranking = $this->hub->ranking()->ranking;
        $this->assertCount(2, $ranking);
        $this->assertFileExists($this->dir . '/ratings.json');
        $this->assertSame($ra['rating'], $ranking->ratingOf('Alice'));
        $this->assertSame($rb['rating'], $ranking->ratingOf('Bob'));
        $this->assertSame(ClientStatus::Playing, $b->status, 'fenêtre de revanche');
    }

    public function testFriendlyMatchesDoNotTouchTheRanking(): void
    {
        [$a, $ta] = $this->connect('Alice', self::token('a'));
        [$b] = $this->connect('Bob');                              // invité : pas de jeton
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->untilGo();
        $this->assertFalse($ta->last('match')['ranked']);
        $this->loseByStacking($a);
        $this->assertNotNull($ta->last('result'));
        $this->assertArrayNotHasKey('delta', $ta->last('result'));
        $this->assertSame(0, $this->hub->ranking()->ranking->count());
    }

    public function testLeavingEarlyIsAForfeitWithoutRatingButAfterTenSecondsItCounts(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->ticks(5);
        $this->say($a, ['t' => 'leave']);
        $rb = $tb->last('result');
        $this->assertTrue($rb['forfeit']);
        $this->assertNotNull($tb->last('oppleft'));
        $this->assertArrayNotHasKey('delta', $rb, 'parti avant 10 s : pas de classement');
        $this->assertSame(ClientStatus::Lobby, $b->status);
        $this->assertSame(0, $this->hub->matchCount());

        [$c, $tc, $d, $td] = $this->startRankedMatch('Carl', 'Dora');
        $this->untilGo();
        $this->ticks(600);
        $this->say($c, ['t' => 'leave']);
        $this->assertArrayHasKey('delta', $td->last('result'), 'après 10 s un abandon compte');
        $this->assertLessThan(0, $tc->last('result')['delta']);
    }

    public function testDisconnectDuringAMatchNotifiesTheOpponent(): void
    {
        [$a, , , $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->hub->disconnect($a);
        $this->assertNotNull($tb->last('oppleft'));
        $this->assertTrue($tb->last('result')['forfeit']);
        $this->assertSame(0, $this->hub->matchCount());
        $this->assertCount(1, $this->hub->lobby);
    }

    public function testRematchStartsANewMatchWhenBothAsk(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->loseByStacking($a);
        $this->assertNotNull($ta->last('result'));
        $this->say($a, ['t' => 'rematch']);
        $this->assertNotNull($tb->last('rematch_ask'));
        $matches = count($ta->of('match'));
        $this->say($b, ['t' => 'rematch']);
        $this->assertCount($matches + 1, $ta->of('match'));
        $this->assertSame(1, $this->hub->matchCount());
        $this->assertCount(2, $ta->of('cd'), 'nouveau compte à rebours');
        $this->untilGo();
        $this->assertTrue($ta->last('s')['b'][0]['al'], 'plateaux neufs');
    }

    public function testRematchWindowClosesAndSendsPlayersBackToTheLobby(): void
    {
        [$a, $ta, $b, $tb] = $this->startRankedMatch();
        $this->untilGo();
        $this->loseByStacking($a);
        $this->clock->advance(31);
        $this->ticks(1);
        $this->assertNotNull($ta->last('left'));
        $this->assertNotNull($tb->last('left'));
        $this->assertSame(ClientStatus::Lobby, $a->status);
        $this->assertSame(0, $this->hub->matchCount());
        $this->say($a, ['t' => 'rematch']);
        $this->assertCount(1, $ta->of('match'), 'plus de revanche possible');
    }

    public function testCountdownOfZeroStartsImmediately(): void
    {
        $this->hub = $this->makeHub(0);
        [, $ta] = $this->startRankedMatch();
        $this->assertNotNull($ta->last('go'));
        $this->assertNotNull($ta->last('s'));
    }

    public function testPlayersOnTheSameAddressPlayAFriendlyMatchWithAReason(): void
    {
        [$a, $ta] = $this->connect('Alice', self::token('a'), '198.51.100.5');
        [$b, $tb] = $this->connect('Bob', self::token('b'), '198.51.100.5');
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertFalse($ta->last('match')['ranked']);
        $this->assertSame('same_ip', $ta->last('match')['why']);
        $this->assertSame('same_ip', $tb->last('match')['why']);
    }

    public function testPlayersOnDifferentAddressesAreRankedWithoutAnyReason(): void
    {
        [$a, $ta] = $this->connect('Alice', self::token('a'), '198.51.100.5');
        [$b] = $this->connect('Bob', self::token('b'), '198.51.100.6');
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertTrue($ta->last('match')['ranked']);
        $this->assertArrayNotHasKey('why', $ta->last('match'));
    }

    public function testAMatchWithoutAnyKnownAddressIsNeverRefused(): void
    {
        $ta = new FakeTransport();
        $tb = new FakeTransport();
        $a = $this->hub->accept($ta);
        $b = $this->hub->accept($tb);
        $this->say($a, ['t' => 'hello', 'name' => 'Alice', 'token' => self::token('a')]);
        $this->say($b, ['t' => 'hello', 'name' => 'Bob', 'token' => self::token('b')]);
        $this->say($a, ['t' => 'queue']);
        $this->say($b, ['t' => 'queue']);
        $this->assertTrue($ta->last('match')['ranked']);
    }

    public function testAFourthAccountFromOneAddressIsNotRanked(): void
    {
        $results = [];
        for ($i = 1; $i <= 4; $i++) {
            [$a, $ta] = $this->connect("Farm$i", self::token("farm$i"), '198.51.100.50');
            [$b] = $this->connect("Real$i", self::token("real$i"), "198.51.100.1$i");
            $this->say($a, ['t' => 'queue']);
            $this->say($b, ['t' => 'queue']);
            $results[] = [$ta->last('match')['ranked'], $ta->last('match')['why'] ?? null];
            $this->hub->disconnect($a);
            $this->hub->disconnect($b);
        }
        $this->assertSame([[true, null], [true, null], [true, null], [false, 'too_many_accounts']], $results);
    }

    public function testTwoAddressesCannotSwapVictoriesMoreThanAFewTimesEvenAfterReconnecting(): void
    {
        $results = [];
        for ($i = 1; $i <= 5; $i++) {
            [$a, $ta] = $this->connect('Alice', self::token('a'), '198.51.100.7');
            [$b] = $this->connect('Bob', self::token('b'), '198.51.100.8');
            $this->say($a, ['t' => 'queue']);
            $this->say($b, ['t' => 'queue']);
            $results[] = $ta->last('match')['why'] ?? 'ranked';
            $this->hub->disconnect($a);
            $this->hub->disconnect($b);
        }
        $this->assertSame(['ranked', 'ranked', 'ranked', 'ranked', 'pair_limit'], $results);
    }

    public function testAClientKnowsItsAddressOnceTheServerHasResolvedIt(): void
    {
        [$a] = $this->connect('Alice', null, '203.0.113.99');
        $this->assertSame('203.0.113.99', $a->ip);
    }
}
