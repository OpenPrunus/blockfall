<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** Ce qui s'est passé pendant une image (pour les sons, les effets et l'envoi des lignes à l'adversaire). */
enum EventType: string
{
    case Lock = 'lock';
    case Clear = 'clear';
    case Attack = 'attack';
    case Garbage = 'garbage';
    case Hold = 'hold';
    case Dead = 'dead';
}
