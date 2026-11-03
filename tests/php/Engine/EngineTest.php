<?php

declare(strict_types=1);

namespace Blockfall\Tests\Engine;

use Blockfall\Engine\Action;
use Blockfall\Engine\Board;
use Blockfall\Engine\EventType;
use Blockfall\Engine\Input;
use Blockfall\Engine\Rules;
use Blockfall\Engine\Shapes;
use Blockfall\Engine\Versus;
use PHPUnit\Framework\TestCase;

final class EngineTest extends TestCase
{
    private static function idle(): Input
    {
        return new Input();
    }

    private static function hardDrop(): Input
    {
        return new Input(actions: [Action::Hd]);
    }

    /** Avance jusqu'à ce qu'une pièce soit en jeu. */
    private static function ready(Board $b): Board
    {
        for ($i = 0; $i < 100 && $b->piece === null && $b->alive; $i++) {
            $b->step(self::idle());
        }

        return $b;
    }

    public function testShapesHaveFourCellsInEveryRotation(): void
    {
        for ($t = 0; $t < 7; $t++) {
            for ($r = 0; $r < 4; $r++) {
                $this->assertCount(4, Shapes::cells($t, $r));
            }
        }
        $this->assertSame([[2, 0], [2, 1], [2, 2], [2, 3]], Shapes::cells(0, 1), 'I verticale');
        $this->assertSame(Shapes::cells(1, 0), Shapes::cells(1, 2), 'O ne tourne pas');
        $this->assertCount(5, Shapes::kicks(2, 0, 1));
        $this->assertSame([0, 0], Shapes::kicks(0, 0, 1)[0]);
    }

    public function testTheSameSeedGivesTheSamePiecesAndEachBagHasSevenDifferentOnes(): void
    {
        $a = new Board(2024);
        $b = new Board(2024);
        $this->assertSame($a->queue, $b->queue);
        $this->assertNotSame((new Board(1))->queue, (new Board(2))->queue);
        $types = [];
        $board = new Board(77);
        for ($i = 0; $i < 14; $i++) {
            self::ready($board);
            $types[] = $board->piece?->type;
            for ($k = 0; $k < ($i % 5) * 12 + 1; $k++) {                    // on répartit les pièces pour ne pas perdre trop tôt
                $board->step(new Input(left: $i % 2 === 0, right: $i % 2 === 1));
            }
            $board->step(self::hardDrop());
        }
        $this->assertCount(7, array_unique(array_slice($types, 0, 7)));
        $this->assertCount(7, array_unique(array_slice($types, 7, 7)));
    }

    public function testMovingRepeatsAfterTheDelayAndLeftPlusRightDoesNothing(): void
    {
        $b = self::ready(new Board(3));
        $x0 = $b->piece?->x ?? 0;
        $b->step(new Input(left: true));
        $this->assertSame($x0 - 1, $b->piece?->x);
        for ($i = 0; $i < Rules::DAS - 1; $i++) {
            $b->step(new Input(left: true));
        }
        $this->assertSame($x0 - 1, $b->piece?->x, 'avant le DAS : pas de répétition');
        $b->step(new Input(left: true));
        $this->assertSame($x0 - 2, $b->piece?->x, 'le DAS est écoulé');
        $c = self::ready(new Board(4));
        $xc = $c->piece?->x;
        $c->step(new Input(left: true, right: true));
        $this->assertSame($xc, $c->piece?->x);
    }

    public function testHardDropScoresTwoPerRowAndSpawnsTheNextPiece(): void
    {
        $b = self::ready(new Board(5));
        $id = $b->pieceId;
        $ev = $b->step(self::hardDrop());
        $this->assertGreaterThan(20, $b->score, 'chute de ~19 rangées');
        $this->assertSame(0, $b->score % 2);
        $this->assertSame(EventType::Lock, $ev[0]->type);
        $this->assertNull($b->piece);
        self::ready($b);
        $this->assertSame($id + 1, $b->pieceId);
    }

    public function testGravityPullsThePieceDownAndSoftDropIsFaster(): void
    {
        $b = self::ready(new Board(8));
        $y0 = $b->piece?->y ?? 0;
        for ($i = 0; $i < 240; $i++) {
            $b->step(self::idle());
        }
        $this->assertGreaterThanOrEqual($y0 + 3, $b->piece?->y);
        $s = self::ready(new Board(8));
        $ys = $s->piece?->y ?? 0;
        for ($i = 0; $i < 20; $i++) {
            $s->step(new Input(down: true));
        }
        $this->assertGreaterThanOrEqual($ys + 9, $s->piece?->y);
        $this->assertGreaterThanOrEqual(9, $s->score);
    }

    public function testHoldSwapsOncePerPiece(): void
    {
        $b = self::ready(new Board(12));
        $first = $b->piece?->type;
        $queued = $b->queue[0];
        $b->step(new Input(actions: [Action::Hold]));
        $this->assertSame($first, $b->hold);
        $this->assertSame($queued, $b->piece?->type);
        $this->assertFalse($b->canHold);
        $b->step(new Input(actions: [Action::Hold]));
        $this->assertSame($first, $b->hold, 'deuxième réserve refusée');
    }

    public function testReceivedLinesAppearWithOneHoleWhenAPieceLocksWithoutAClear(): void
    {
        $v = new Versus(21);
        $b = $v->boards[1];
        $b->receive(3);
        self::ready($b);
        $this->assertSame(3, $b->pendingLines());
        $ev = $b->step(self::hardDrop());
        $this->assertSame(EventType::Garbage, $ev[1]->type);
        $this->assertSame(3, $ev[1]->n);
        $this->assertSame(0, $b->pendingLines());
        $rows = str_split($b->gridString(), Rules::COLS);
        $garbage = array_values(array_filter($rows, static fn (string $r): bool => substr_count($r, '8') === 9));
        $this->assertCount(3, $garbage);
        $this->assertSame(strpos($garbage[0], '0'), strpos($garbage[2], '0'), 'même trou pour un même envoi');
    }

    public function testStackingInTheMiddleEndsTheGameAndADeadBoardStopsMoving(): void
    {
        $b = new Board(16);
        for ($i = 0; $i < 400 && $b->alive; $i++) {
            $b->step(self::hardDrop());
        }
        $this->assertFalse($b->alive);
        $frame = $b->frame;
        $b->step(new Input(left: true));
        $this->assertSame($frame, $b->frame);
    }

    public function testBothVersusBoardsStartWithTheSamePiecesAndALoserEndsTheDuel(): void
    {
        $v = new Versus(777);
        $this->assertSame($v->boards[0]->queue, $v->boards[1]->queue);
        for ($i = 0; $i < 600 && $v->winner === null; $i++) {
            $v->step([self::hardDrop(), self::idle()]);
        }
        $this->assertSame(1, $v->winner, 'le plateau 0 empile tout au centre et perd');
        $this->assertFalse($v->boards[0]->alive);
        $this->assertTrue($v->boards[1]->alive);
    }

    public function testVersusLevelRisesWithTime(): void
    {
        $v = new Versus(5);
        for ($i = 0; $i < Rules::TIME_LEVEL * 2 + 5; $i++) {
            $v->step([self::idle(), self::idle()]);
            if ($v->winner !== null) {
                break;
            }
        }
        $this->assertGreaterThanOrEqual(3, $v->boards[1]->level);
    }

    public function testInputFromBitsAndActions(): void
    {
        $i = Input::fromBits(5, 'cw,hd,bogus');
        $this->assertTrue($i->left);
        $this->assertFalse($i->right);
        $this->assertTrue($i->down);
        $this->assertSame([Action::Cw, Action::Hd], $i->actions);
        $this->assertSame([], Input::fromBits(0)->actions);
    }
}
