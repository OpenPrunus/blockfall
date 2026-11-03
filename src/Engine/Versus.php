<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** Un duel : deux plateaux avec la même suite de pièces ; les lignes envoyées arrivent chez l'adversaire à l'image suivante. */
final class Versus
{
    /** @var array{Board, Board} */
    public readonly array $boards;
    public private(set) int $frame = 0;
    public private(set) ?int $winner = null;

    public function __construct(int $seed)
    {
        $this->boards = [
            new Board($seed, ($seed + 1) & 0xFFFFFFFF, Board::VERSUS),
            new Board($seed, ($seed + 2) & 0xFFFFFFFF, Board::VERSUS),
        ];
    }

    /**
     * Avance le duel d'une image.
     *
     * @param array{Input, Input} $inputs entrée du plateau 0 et du plateau 1
     * @return array{list<GameEvent>, list<GameEvent>} événements de chaque plateau
     */
    public function step(array $inputs): array
    {
        if ($this->winner !== null) {
            return [[], []];
        }
        $this->frame++;
        $evs = [$this->boards[0]->step($inputs[0]), $this->boards[1]->step($inputs[1])];
        foreach ([0, 1] as $i) {
            foreach ($evs[$i] as $e) {
                if ($e->type === EventType::Attack) {
                    $this->boards[1 - $i]->receive($e->n);
                }
            }
        }
        [$a, $b] = $this->boards;
        if (!$a->alive || !$b->alive) {
            $this->winner = $a->alive ? 0 : ($b->alive ? 1 : ($a->score >= $b->score ? 0 : 1));
        }

        return $evs;
    }
}
