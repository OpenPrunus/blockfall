<?php

declare(strict_types=1);

namespace Blockfall\Engine;

final readonly class GameEvent
{
    /** @param list<int> $rows rangées effacées (pour un effacement de lignes) */
    public function __construct(public EventType $type, public int $n = 0, public array $rows = [])
    {
    }
}
