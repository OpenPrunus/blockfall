<?php

declare(strict_types=1);

namespace Blockfall\Tests\Engine;

use Blockfall\Engine\Board;
use Blockfall\Engine\Input;
use Blockfall\Engine\Versus;
use PHPUnit\Framework\TestCase;

/** Rejoue en PHP les parties enregistrées par le moteur JavaScript (npm run fixtures) : mêmes entrées, mêmes résumés à chaque contrôle. */
final class FixturesTest extends TestCase
{
    public function testPhpReplaysTheJavaScriptGames(): void
    {
        $file = dirname(__DIR__, 2) . '/fixtures/engine-vectors.json';
        $this->assertFileExists($file);
        /** @var array{games: list<array<string, mixed>>} $data */
        $data = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        $this->assertCount(7, $data['games']);
        $checked = 0;
        foreach ($data['games'] as $g) {
            $versus = $g['kind'] === 'versus';
            $world = $versus ? new Versus($g['seed']) : null;
            $solo = $versus ? null : new Board($g['seed'], null, Board::MARATHON, $g['startLevel']);
            $boards = $world !== null ? $world->boards : [$solo];
            /** @var array<int, list<array{int, int, int, string}>> $byFrame */
            $byFrame = [];
            foreach ($g['inputs'] as $e) {
                $byFrame[$e[0]][] = $e;
            }
            $held = array_fill(0, count($boards), 0);
            $checks = [];
            foreach ($g['checks'] as [$frame, $snaps]) {
                $checks[$frame] = $snaps;
            }
            for ($f = 1; $f <= $g['frames']; $f++) {
                $actions = array_fill(0, count($boards), '');
                foreach ($byFrame[$f] ?? [] as [, $side, $bits, $acts]) {
                    $held[$side] = $bits;
                    $actions[$side] = $acts;
                }
                $inputs = array_map(static fn (int $i): Input => Input::fromBits($held[$i], $actions[$i]), array_keys($boards));
                if ($world !== null) {
                    $world->step([$inputs[0], $inputs[1]]);
                } else {
                    $solo?->step($inputs[0]);
                }
                if (isset($checks[$f])) {
                    foreach ($boards as $i => $board) {
                        $this->assertSame($checks[$f][$i], $board->snapshot(), "{$g['name']}, image $f, plateau $i");
                        $checked++;
                    }
                }
            }
            if ($world !== null) {
                $this->assertSame($g['winner'], $world->winner, "{$g['name']} : vainqueur");
            }
        }
        $this->assertGreaterThan(300, $checked);
    }
}
