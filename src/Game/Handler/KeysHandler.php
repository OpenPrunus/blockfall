<?php

declare(strict_types=1);

namespace Blockfall\Game\Handler;

use Blockfall\Game\Client;
use Blockfall\Game\MatchService;

/** Touches tenues du joueur (gauche, droite, chute douce) : envoyé seulement quand elles changent. */
final readonly class KeysHandler implements MessageHandler
{
    public function __construct(private MatchService $matches)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $this->matches->setKeys($client, ($msg['l'] ?? false) === true, ($msg['r'] ?? false) === true, ($msg['d'] ?? false) === true);
    }
}
