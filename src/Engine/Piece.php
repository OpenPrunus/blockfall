<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** La pièce en jeu : son type, sa rotation (0-3) et la position de sa boîte dans la grille. */
final class Piece
{
    public function __construct(public int $type, public int $rot, public int $x, public int $y)
    {
    }
}
