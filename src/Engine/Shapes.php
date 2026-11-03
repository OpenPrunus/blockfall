<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** Formes des pièces dans leurs quatre rotations et rebonds SRS. */
final class Shapes
{
    /** @var array<int, array{int, list<array{int, int}>}> */
    private const array BASE = [
        0 => [4, [[0, 1], [1, 1], [2, 1], [3, 1]]],   // I
        1 => [4, [[1, 0], [2, 0], [1, 1], [2, 1]]],   // O
        2 => [3, [[1, 0], [0, 1], [1, 1], [2, 1]]],   // T
        3 => [3, [[1, 0], [2, 0], [0, 1], [1, 1]]],   // S
        4 => [3, [[0, 0], [1, 0], [1, 1], [2, 1]]],   // Z
        5 => [3, [[0, 0], [0, 1], [1, 1], [2, 1]]],   // J
        6 => [3, [[2, 0], [0, 1], [1, 1], [2, 1]]],   // L
    ];

    /** @var array<int, list<array{int, int}>> rebonds [dx, dy vers le HAUT], indexés par 4 × rotation de départ + rotation d'arrivée */
    private const array KICK_3 = [
        1 => [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], 4 => [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
        6 => [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], 9 => [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
        11 => [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], 14 => [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
        12 => [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], 3 => [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    ];

    /** @var array<int, list<array{int, int}>> */
    private const array KICK_I = [
        1 => [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], 4 => [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
        6 => [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], 9 => [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
        11 => [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], 14 => [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
        12 => [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], 3 => [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    ];

    /** @var array<int, list<list<array{int, int}>>>|null */
    private static ?array $cache = null;

    /**
     * Les quatre cases [x, y] de la pièce dans sa boîte.
     *
     * @return list<array{int, int}>
     */
    public static function cells(int $type, int $rot): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (self::BASE as $t => [$n, $cells]) {
                $rots = [$cells];
                for ($r = 1; $r < 4; $r++) {
                    $previous = $rots[$r - 1];
                    $rots[] = $t === 1 ? $cells : array_map(static fn (array $c): array => [$n - 1 - $c[1], $c[0]], $previous);
                }
                self::$cache[$t] = $rots;
            }
        }

        return self::$cache[$type][$rot];
    }

    /**
     * Rebonds à essayer pour passer de la rotation `$from` à `$to` (O : aucun, elle ne tourne pas).
     *
     * @return list<array{int, int}>
     */
    public static function kicks(int $type, int $from, int $to): array
    {
        $table = $type === 0 ? self::KICK_I : self::KICK_3;

        return $table[$from * 4 + $to];
    }
}
