<?php

declare(strict_types=1);

namespace Blockfall\Game\Handler;

use Blockfall\Game\Client;
use Blockfall\Game\MatchService;

final readonly class LeaveHandler implements MessageHandler
{
    public function __construct(private MatchService $matches)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $this->matches->leave($client);
    }
}
