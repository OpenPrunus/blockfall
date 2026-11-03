<?php

declare(strict_types=1);

namespace Blockfall\Game;

use Arcade\Support\Env;

/** Réglages du serveur de jeu (durées en secondes). */
final readonly class HubConfig
{
    public function __construct(
        public int $countdown = 3,
        public int $maxClients = 300,
        public int $inviteTtl = 20,
        public int $rematchTtl = 30,
        public int $rateLimit = 120,
        public int $forfeitFrames = 600,
    ) {
    }

    public static function fromEnvironment(): self
    {
        return new self(
            countdown: (int) Env::number('BLOCKFALL_COUNTDOWN', 3, true),
            inviteTtl: (int) Env::number('BLOCKFALL_INVITE_TTL', 20),
            rematchTtl: (int) Env::number('BLOCKFALL_REMATCH_TTL', 30),
        );
    }
}
