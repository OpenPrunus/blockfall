<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** Plateau d'un duel : le premier ou le second (le même côté de l'écran pour tout le match). */
enum Side: int
{
    case Left = 0;
    case Right = 1;

    public function opposite(): self
    {
        return match ($this) {
            self::Left => self::Right,
            self::Right => self::Left,
        };
    }
}
