<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/**
 * Le plateau d'un joueur : grille de 10 colonnes sur 22 rangées (les deux du haut sont cachées), pièces SRS, sacs de sept,
 * gravité, délai de verrouillage, répétition des déplacements, réserve, lignes reçues. Que des entiers : même entrée, même résultat.
 * Port exact de web/js/engine.js.
 */
final class Board
{
    final public const string MARATHON = 'marathon';
    final public const string VERSUS = 'versus';

    private int $rng;
    private int $grng;
    /** @var list<int> */
    public private(set) array $queue = [];
    /** @var array<int, array<int, int>> */
    public private(set) array $grid;
    public private(set) ?Piece $piece = null;
    public private(set) int $pieceId = 0;
    public private(set) int $hold = -1;
    public private(set) bool $canHold = true;
    public private(set) int $score = 0;
    public private(set) int $lines = 0;
    public private(set) int $level;
    public private(set) bool $alive = true;
    public private(set) int $frame = 0;
    /** @var list<int> lignes reçues qui attendent d'arriver, par envoi */
    public private(set) array $pending = [];
    private int $gAcc = 0;
    private int $softAcc = 0;
    private int $lockTimer = 0;
    private int $lockResets = 0;
    private int $dasDir = 0;
    private int $dasTimer = 0;
    private int $are = Rules::ARE;
    private int $combo = -1;
    private bool $b2b = false;

    public function __construct(int $seed, ?int $garbageSeed = null, private readonly string $mode = self::MARATHON, private readonly int $startLevel = 1)
    {
        $this->rng = ($seed & 0xFFFFFFFF) ?: 1;
        $this->grng = (($garbageSeed ?? ($seed ^ 0x9e3779b9)) & 0xFFFFFFFF) ?: 1;
        $this->level = $startLevel;
        $this->grid = array_fill(0, Rules::ROWS, array_fill(0, Rules::COLS, 0));
        $this->refill();
    }

    /** Lignes qui attendent d'arriver chez ce plateau. */
    public function pendingLines(): int
    {
        return array_sum($this->pending);
    }

    /** Ajoute des lignes reçues de l'adversaire (elles arrivent à la prochaine pose sans ligne). */
    public function receive(int $lines): void
    {
        $this->pending[] = $lines;
    }

    /**
     * Avance d'une image (1/60 s) et renvoie ce qui s'est passé.
     *
     * @return list<GameEvent>
     */
    public function step(Input $input): array
    {
        $ev = [];
        if (!$this->alive) {
            return $ev;
        }
        $this->frame++;
        $this->level = $this->levelOf();
        $dir = $input->right && !$input->left ? 1 : ($input->left && !$input->right ? -1 : 0);
        if ($dir !== $this->dasDir) {
            $this->dasDir = $dir;
            $this->dasTimer = 0;
            if ($dir !== 0 && $this->piece !== null) {
                $this->move($dir);
            }
        } elseif ($dir !== 0) {
            $this->dasTimer++;
            if ($this->dasTimer >= Rules::DAS && ($this->dasTimer - Rules::DAS) % Rules::ARR === 0 && $this->piece !== null) {
                $this->move($dir);
            }
        }
        foreach ($input->actions as $action) {
            if ($this->piece === null || !$this->alive) {
                break;
            }
            $this->act($action, $ev);
        }
        if (!$this->alive) {
            return $ev;
        }
        if ($this->piece !== null) {
            if ($input->down) {
                if (++$this->softAcc >= Rules::SOFT) {
                    $this->softAcc = 0;
                    if ($this->shift(0, 1)) {
                        $this->score += 1;
                    }
                }
            } else {
                $this->softAcc = 0;
            }
            $this->gAcc += Rules::GRAVITY[$this->level];
            while ($this->gAcc >= 65536) {
                $this->gAcc -= 65536;
                if (!$this->shift(0, 1)) {
                    $this->gAcc = 0;
                    break;
                }
            }
            if ($this->grounded()) {
                if (++$this->lockTimer >= Rules::LOCK_DELAY) {
                    $this->lockPiece($ev);
                }
            } else {
                $this->lockTimer = 0;
            }
        } elseif (--$this->are <= 0) {
            $this->spawn($ev);
        }

        return $ev;
    }

    /** Grille visible (20 rangées) sous forme de texte : un chiffre par case (0 vide, 1-7 pièces, 8 lignes reçues). */
    public function gridString(): string
    {
        $s = '';
        for ($y = Rules::HIDDEN; $y < Rules::ROWS; $y++) {
            $s .= implode('', $this->grid[$y]);
        }

        return $s;
    }

    /**
     * Résumé du plateau : de quoi l'afficher, le comparer ou l'envoyer.
     *
     * @return array{g: string, p: list<int>|null, q: list<int>, h: int, ch: bool, sc: int, ln: int, lv: int, pg: int, al: bool}
     */
    public function snapshot(): array
    {
        return [
            'g' => $this->gridString(),
            'p' => $this->piece === null ? null : [$this->piece->type, $this->piece->rot, $this->piece->x, $this->piece->y],
            'q' => array_slice($this->queue, 0, 5),
            'h' => $this->hold,
            'ch' => $this->canHold,
            'sc' => $this->score,
            'ln' => $this->lines,
            'lv' => $this->level,
            'pg' => $this->pendingLines(),
            'al' => $this->alive,
        ];
    }

    // ------------------------------------------------------------------------------------------------ interne

    /** Générateur xorshift32 (entiers 32 bits, identique à celui du JavaScript). */
    private function next(int &$state): int
    {
        $s = $state;
        $s ^= ($s << 13) & 0xFFFFFFFF;
        $s ^= $s >> 17;
        $s ^= ($s << 5) & 0xFFFFFFFF;
        $state = $s;

        return $s;
    }

    private function refill(): void
    {
        while (count($this->queue) < Rules::QUEUE) {
            $bag = [0, 1, 2, 3, 4, 5, 6];
            for ($i = 6; $i > 0; $i--) {
                $j = $this->next($this->rng) % ($i + 1);
                [$bag[$i], $bag[$j]] = [$bag[$j], $bag[$i]];
            }
            array_push($this->queue, ...$bag);
        }
    }

    private function levelOf(): int
    {
        $level = $this->mode === self::VERSUS ? 1 + intdiv($this->frame, Rules::TIME_LEVEL) : $this->startLevel + intdiv($this->lines, 10);

        return min(Rules::MAX_LEVEL, $level);
    }

    private function collides(int $type, int $rot, int $x, int $y): bool
    {
        foreach (Shapes::cells($type, $rot) as [$cx, $cy]) {
            $px = $x + $cx;
            $py = $y + $cy;
            if ($px < 0 || $px >= Rules::COLS || $py < 0 || $py >= Rules::ROWS || $this->grid[$py][$px] !== 0) {
                return true;
            }
        }

        return false;
    }

    private function spawnPiece(int $type): void
    {
        $this->piece = new Piece($type, 0, 3, 0);
        $this->pieceId++;
        $this->lockTimer = 0;
        $this->lockResets = 0;
        $this->gAcc = 0;
        if ($this->collides($type, 0, 3, 0)) {
            $this->alive = false;                              // plus de place : perdu
        }
    }

    /** @param list<GameEvent> $ev */
    private function spawn(array &$ev): void
    {
        $type = array_shift($this->queue) ?? 0;
        $this->refill();
        $this->spawnPiece($type);
        if (!$this->alive) {
            $ev[] = new GameEvent(EventType::Dead);
        }
    }

    private function grounded(): bool
    {
        $p = $this->piece ?? throw new \LogicException('no piece');

        return $this->collides($p->type, $p->rot, $p->x, $p->y + 1);
    }

    private function shift(int $dx, int $dy): bool
    {
        $p = $this->piece ?? throw new \LogicException('no piece');
        if ($this->collides($p->type, $p->rot, $p->x + $dx, $p->y + $dy)) {
            return false;
        }
        $p->x += $dx;
        $p->y += $dy;

        return true;
    }

    /** Après un déplacement ou une rotation réussis au sol : le délai de verrouillage repart (dans la limite des remises). */
    private function touched(): void
    {
        if ($this->grounded() && $this->lockResets < Rules::MAX_RESETS) {
            $this->lockTimer = 0;
            $this->lockResets++;
        }
    }

    private function move(int $dx): void
    {
        if ($this->shift($dx, 0)) {
            $this->touched();
        }
    }

    /** Rotation avec rebonds SRS. `$dir` : 1 = horaire, -1 = anti-horaire. */
    private function rotate(int $dir): void
    {
        $p = $this->piece ?? throw new \LogicException('no piece');
        $to = ($p->rot + $dir + 4) % 4;
        if ($p->type === 1) {                                   // O : la rotation ne change rien
            $p->rot = $to;
            $this->touched();

            return;
        }
        foreach (Shapes::kicks($p->type, $p->rot, $to) as [$kx, $ky]) {
            $nx = $p->x + $kx;
            $ny = $p->y - $ky;
            if (!$this->collides($p->type, $to, $nx, $ny)) {
                $p->rot = $to;
                $p->x = $nx;
                $p->y = $ny;
                $this->touched();

                return;
            }
        }
    }

    /** @param list<GameEvent> $ev */
    private function holdPiece(array &$ev): void
    {
        if (!$this->canHold) {
            return;
        }
        $cur = ($this->piece ?? throw new \LogicException('no piece'))->type;
        $this->canHold = false;
        $ev[] = new GameEvent(EventType::Hold);
        if ($this->hold < 0) {
            $this->hold = $cur;
            $this->piece = null;
            $this->spawn($ev);
            $this->canHold = false;
        } else {
            $swap = $this->hold;
            $this->hold = $cur;
            $this->spawnPiece($swap);
            if (!$this->alive) {
                $ev[] = new GameEvent(EventType::Dead);
            }
        }
    }

    /** @param list<GameEvent> $ev */
    private function act(Action $action, array &$ev): void
    {
        switch ($action) {
            case Action::Cw:
                $this->rotate(1);
                break;
            case Action::Ccw:
                $this->rotate(-1);
                break;
            case Action::Hold:
                $this->holdPiece($ev);
                break;
            case Action::Hd:
                $d = 0;
                while ($this->shift(0, 1)) {
                    $d++;
                }
                $this->score += 2 * $d;
                $this->lockPiece($ev);
                break;
        }
    }

    /** @param list<GameEvent> $ev */
    private function applyGarbage(array &$ev): void
    {
        $total = 0;
        while ($this->pending !== [] && $total < Rules::GARBAGE_CAP) {
            $take = min($this->pending[0], Rules::GARBAGE_CAP - $total);
            $total += $take;
            $this->pending[0] -= $take;
            if ($this->pending[0] === 0) {
                array_shift($this->pending);
            }
            $hole = $this->next($this->grng) % Rules::COLS;
            for ($k = 0; $k < $take; $k++) {
                $row = array_fill(0, Rules::COLS, Rules::GARBAGE);
                $row[$hole] = 0;
                $grid = $this->grid;
                array_shift($grid);
                $grid[] = $row;
                $this->grid = $grid;
            }
        }
        if ($total > 0) {
            $ev[] = new GameEvent(EventType::Garbage, $total);
        }
    }

    /** @param list<GameEvent> $ev */
    private function lockPiece(array &$ev): void
    {
        $p = $this->piece ?? throw new \LogicException('no piece');
        $lockOut = true;
        $grid = $this->grid;
        foreach (Shapes::cells($p->type, $p->rot) as [$cx, $cy]) {
            $grid[$p->y + $cy][$p->x + $cx] = $p->type + 1;
            if ($p->y + $cy >= Rules::HIDDEN) {
                $lockOut = false;
            }
        }
        $this->grid = $grid;
        $this->piece = null;
        $this->canHold = true;
        $ev[] = new GameEvent(EventType::Lock);
        $rows = [];
        for ($y = 0; $y < Rules::ROWS; $y++) {
            if (!in_array(0, $this->grid[$y], true)) {
                $rows[] = $y;
            }
        }
        if ($rows !== []) {
            $kept = array_values(array_filter($this->grid, static fn (array $row, int $y): bool => !in_array($y, $rows, true), ARRAY_FILTER_USE_BOTH));
            $n = count($rows);
            $this->grid = [...array_fill(0, $n, array_fill(0, Rules::COLS, 0)), ...$kept];
            $this->combo++;
            $pts = Rules::LINE_POINTS[$n] * $this->level;
            if ($n === 4 && $this->b2b) {
                $pts = intdiv($pts * 3, 2);
            }
            $pts += 50 * $this->combo * $this->level;
            $this->score += $pts;
            $this->lines += $n;
            $attack = Rules::ATTACK[$n] + ($n === 4 && $this->b2b ? 1 : 0) + Rules::COMBO_BONUS[min($this->combo, count(Rules::COMBO_BONUS) - 1)];
            $this->b2b = $n === 4;
            while ($attack > 0 && $this->pending !== []) {       // les lignes envoyées annulent d'abord celles qu'on allait recevoir
                $t = min($this->pending[0], $attack);
                $this->pending[0] -= $t;
                $attack -= $t;
                if ($this->pending[0] === 0) {
                    array_shift($this->pending);
                }
            }
            $ev[] = new GameEvent(EventType::Clear, $n, $rows);
            if ($attack > 0) {
                $ev[] = new GameEvent(EventType::Attack, $attack);
            }
            $this->are = Rules::CLEAR_ARE;
        } else {
            $this->combo = -1;
            $this->applyGarbage($ev);
            $this->are = Rules::ARE;
        }
        if ($lockOut) {
            $this->alive = false;
            $ev[] = new GameEvent(EventType::Dead);
        }
    }
}
