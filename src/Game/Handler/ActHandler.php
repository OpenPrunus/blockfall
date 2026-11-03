<?php

declare(strict_types=1);

namespace Blockfall\Game\Handler;

use Blockfall\Engine\Action;
use Blockfall\Game\Client;
use Blockfall\Game\MatchService;

/** Une action du joueur : rotation, chute dure, réserve. */
final readonly class ActHandler implements MessageHandler
{
    public function __construct(private MatchService $matches)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $action = is_string($msg['a'] ?? null) ? Action::tryFrom($msg['a']) : null;
        if ($action === null) {
            $client->error('bad_action');

            return;
        }
        $this->matches->act($client, $action);
    }
}
