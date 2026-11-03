<?php

declare(strict_types=1);

namespace Blockfall\Game;

/** Messages que le navigateur peut envoyer (champ `t`). */
enum ClientMessage: string
{
    case Ping = 'ping';
    case Hello = 'hello';
    case Keys = 'keys';
    case Act = 'act';
    case Queue = 'queue';
    case Unqueue = 'unqueue';
    case Challenge = 'challenge';
    case Accept = 'accept';
    case Decline = 'decline';
    case Cancel = 'cancel';
    case Leave = 'leave';
    case Rematch = 'rematch';

    /** Tout sauf le ping et l'inscription exige d'avoir un pseudo. */
    public function needsName(): bool
    {
        return $this !== self::Ping && $this !== self::Hello;
    }
}
