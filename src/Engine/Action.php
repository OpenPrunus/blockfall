<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** Ce qu'un joueur peut faire d'un coup (par opposition aux touches tenues) : un pas de côté, une rotation, la chute dure, la réserve. */
enum Action: string
{
    case Left = 'left';
    case Right = 'right';
    case Cw = 'cw';
    case Ccw = 'ccw';
    case Hd = 'hd';
    case Hold = 'hold';
}
