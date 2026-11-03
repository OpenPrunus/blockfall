<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** L'entrée d'une image : touches tenues (gauche, droite, chute douce) et actions pressées pendant cette image. */
final readonly class Input
{
    /** @param list<Action> $actions */
    public function __construct(public bool $left = false, public bool $right = false, public bool $down = false, public array $actions = [])
    {
    }

    /** Touches tenues depuis un entier (bit 0 gauche, 1 droite, 2 bas). */
    public static function fromBits(int $bits, string $actions = ''): self
    {
        $list = [];
        foreach ($actions === '' ? [] : explode(',', $actions) as $a) {
            $action = Action::tryFrom($a);
            if ($action !== null) {
                $list[] = $action;
            }
        }

        return new self(($bits & 1) !== 0, ($bits & 2) !== 0, ($bits & 4) !== 0, $list);
    }
}
