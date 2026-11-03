<?php

declare(strict_types=1);

namespace Blockfall\Game;

use Blockfall\Engine\Action;
use Blockfall\Engine\EventType;
use Blockfall\Engine\GameEvent;
use Blockfall\Engine\Rules;
use Blockfall\Engine\Side;
use Blockfall\Ranking\Participant;
use Blockfall\Ranking\RankedMatch;
use Psr\Clock\ClockInterface;
use Psr\Log\LoggerInterface;
use Random\Randomizer;

/** Cycle de vie des matchs : création, compte à rebours, images du moteur à 60 Hz, envoi des états, résultat, forfait et revanche. */
final class MatchService
{
    /** @var list<Room> */
    private array $rooms = [];

    public function __construct(
        private readonly HubConfig $config,
        private readonly Lobby $lobby,
        private readonly MatchQueue $queue,
        private readonly Invitations $invitations,
        private readonly RankingBook $book,
        private readonly ClockInterface $clock,
        private readonly LoggerInterface $logger,
        private readonly Randomizer $randomizer,
    ) {
    }

    public function count(): int
    {
        return count($this->rooms);
    }

    /** Lance un match ; le plateau de chacun est tiré au hasard. */
    public function start(Client $a, Client $b): Room
    {
        foreach ([$a, $b] as $client) {
            $this->queue->leave($client);
            $this->cancelInvitation($client);
        }
        [$first, $second] = $this->randomizer->getInt(0, 1) === 0 ? [$a, $b] : [$b, $a];
        $ranked = $a->hasToken && $b->hasToken && $a->tokenHash !== $b->tokenHash;
        $room = new Room([$first, $second], $ranked, $this->randomizer->getInt(1, 0x7FFFFFFF), $this->config->countdown * Rules::TICKS_PER_SECOND);
        $this->open($room);
        $this->logger->info("Match {$first->name} vs {$second->name} (" . ($ranked ? 'ranked' : 'friendly') . ')');

        return $room;
    }

    private function open(Room $room): void
    {
        $this->rooms[] = $room;
        foreach ([Side::Left, Side::Right] as $side) {
            $player = $room->players[$side->value];
            $opponent = $room->opponentOf($side);
            $player->room = $room;
            $player->status = ClientStatus::Playing;
            $player->send(Event::Match, [
                'side' => $side->value,
                'ranked' => $room->ranked,
                'opp' => ['name' => $opponent->name, 'rating' => $this->book->ranking->ratingOf((string) $opponent->name)],
            ]);
        }
        $this->lobby->dirty = true;
        $this->broadcast($room, Event::Countdown, ['n' => $this->config->countdown]);
        if ($this->config->countdown === 0) {
            $this->go($room);
        }
    }

    private function go(Room $room): void
    {
        $room->phase = RoomPhase::Playing;
        $room->countdownFrames = 0;
        $this->broadcast($room, Event::Go);
        $this->sendState($room, true);
    }

    public function setKeys(Client $client, bool $left, bool $right, bool $down): void
    {
        $room = $client->room;
        $side = $room?->sideOf($client);
        if ($room !== null && $side !== null && !$room->finished) {
            $bits = ($left ? 1 : 0) | ($right ? 2 : 0) | ($down ? 4 : 0);
            $room->held[$side->value] = $bits;
            $room->pulse[$side->value] |= $bits;
        }
    }

    public function act(Client $client, Action $action): void
    {
        $room = $client->room;
        $side = $room?->sideOf($client);
        if ($room !== null && $side !== null && $room->phase === RoomPhase::Playing && count($room->queued[$side->value]) < 8) {
            $room->queued[$side->value][] = $action;
        }
    }

    /** Une image (1/60 s) pour tous les matchs : compte à rebours, moteur, état envoyé aux deux joueurs ; fin de la revanche. */
    public function tick(int $now): void
    {
        foreach ($this->rooms as $room) {
            if ($room->finished) {
                if ($now >= $room->closeAt) {
                    $this->close($room);
                }
                continue;
            }
            if ($room->phase === RoomPhase::Countdown) {
                $room->countdownFrames--;
                if ($room->countdownFrames % Rules::TICKS_PER_SECOND === 0 && $room->countdownFrames > 0) {
                    $this->broadcast($room, Event::Countdown, ['n' => intdiv($room->countdownFrames, Rules::TICKS_PER_SECOND)]);
                }
                if ($room->countdownFrames <= 0) {
                    $this->go($room);
                }
                continue;
            }
            $events = $room->duel->step([$room->takeInput(0), $room->takeInput(1)]);
            $this->sendState($room, false, $events);
            if ($room->duel->winner !== null) {
                $this->finish($room, Side::from($room->duel->winner), false, $now);
            }
        }
    }

    /**
     * Envoie à chaque joueur ce qui a changé depuis le dernier envoi (rien si rien n'a changé et qu'aucun événement n'a eu lieu).
     *
     * @param array{list<GameEvent>, list<GameEvent>}|array{} $events
     */
    private function sendState(Room $room, bool $full, array $events = []): void
    {
        $boards = [];
        $changed = false;
        foreach ([0, 1] as $i) {
            $snap = $room->duel->boards[$i]->snapshot();
            $last = $room->sent[$i];
            $diff = $full ? $snap : array_filter($snap, static fn (mixed $v, string $k): bool => !array_key_exists($k, $last) || $last[$k] !== $v, ARRAY_FILTER_USE_BOTH);
            $room->sent[$i] = $snap;
            $boards[] = $diff;
            $changed = $changed || $diff !== [];
        }
        $ev = [];
        foreach ($events as $side => $list) {
            foreach ($list as $e) {
                $ev[] = [$side, $e->type->value, $e->n, ...($e->type === EventType::Clear ? [$e->rows] : [])];
            }
        }
        if (!$changed && $ev === []) {
            return;
        }
        $this->broadcast($room, Event::State, ['n' => $room->duel->frame, 'b' => $boards, ...($ev !== [] ? ['ev' => $ev] : [])]);
    }

    /** @param array<string, mixed> $data */
    private function broadcast(Room $room, Event $event, array $data = []): void
    {
        foreach ($room->players as $player) {
            $player->send($event, $data);
        }
    }

    /** Annonce le résultat et met à jour le classement. `$forfeit` : un joueur est parti avant la fin. */
    private function finish(Room $room, Side $winner, bool $forfeit, int $now): void
    {
        if ($room->finished) {
            return;
        }
        $room->finished = true;
        $room->phase = RoomPhase::Over;
        $room->closeAt = $now + $this->config->rematchTtl;
        $lines = [$room->duel->boards[0]->lines, $room->duel->boards[1]->lines];
        $result = null;
        if ($room->ranked && (!$forfeit || $room->duel->frame >= $this->config->forfeitFrames)) {
            [$a, $b] = $room->players;
            $result = $this->book->settle(
                new RankedMatch(new Participant((string) $a->name, $a->tokenHash, $lines[0]), new Participant((string) $b->name, $b->tokenHash, $lines[1]), $winner === Side::Left),
                $now,
            );
        }
        foreach ([Side::Left, Side::Right] as $side) {
            $room->players[$side->value]->send(Event::Result, [
                'winner' => $winner->value,
                'forfeit' => $forfeit,
                'lines' => $lines,
                'score' => [$room->duel->boards[0]->score, $room->duel->boards[1]->score],
                'ranked' => $room->ranked,
                ...($result !== null ? ['delta' => $result->deltas[$side->value], 'rating' => $result->ratings[$side->value]] : []),
            ]);
        }
    }

    /** Un joueur quitte (volontairement ou parce qu'il est déconnecté) : forfait si le match n'était pas fini. */
    public function leave(Client $client, ?int $now = null): void
    {
        $room = $client->room;
        $side = $room?->sideOf($client);
        if ($room === null || $side === null) {
            return;
        }
        $now ??= $this->clock->now()->getTimestamp();
        if (!$room->finished) {
            $this->finish($room, $side->opposite(), true, $now);
        }
        $opponent = $room->opponentOf($side);
        $client->room = null;
        $client->status = $client->isNamed ? ClientStatus::Lobby : ClientStatus::New;
        if ($opponent->room === $room) {
            $opponent->room = null;
            $opponent->status = ClientStatus::Lobby;
            $opponent->send(Event::OpponentLeft);
        }
        $this->remove($room);
    }

    /** Demande de revanche ; quand les deux la demandent, un nouveau match commence avec les mêmes joueurs. */
    public function requestRematch(Client $client): void
    {
        $room = $client->room;
        $side = $room?->sideOf($client);
        if ($room === null || $side === null || !$room->finished) {
            return;
        }
        $room->rematch[$side->value] = true;
        $room->opponentOf($side)->send(Event::RematchAsk);
        if ($room->rematch[0] && $room->rematch[1]) {
            $this->remove($room);
            $this->open(new Room($room->players, $room->ranked, $this->randomizer->getInt(1, 0x7FFFFFFF), $this->config->countdown * Rules::TICKS_PER_SECOND));
        }
    }

    /** Fin de la fenêtre de revanche : les deux joueurs retournent au salon. */
    private function close(Room $room): void
    {
        foreach ($room->players as $player) {
            if ($player->room === $room) {
                $player->room = null;
                $player->status = ClientStatus::Lobby;
                $player->send(Event::Left);
            }
        }
        $this->remove($room);
    }

    private function remove(Room $room): void
    {
        $this->rooms = array_values(array_filter($this->rooms, static fn (Room $r): bool => $r !== $room));
        $this->lobby->dirty = true;
    }

    private function cancelInvitation(Client $client): void
    {
        $invitation = $this->invitations->cancel($client);
        if ($invitation !== null) {
            $invitation->other($client)->send(Event::InviteCancel, ['id' => $client->id]);
            $this->lobby->dirty = true;
        }
    }

    /** Pour les tests et le journal : le match est-il en cours ? */
    public function isRunning(Room $room): bool
    {
        return in_array($room, $this->rooms, true) && !$room->finished;
    }
}
