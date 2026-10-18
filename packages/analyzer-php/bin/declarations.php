<?php
declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;

// The input is untrusted repository text. It is parsed as bytes and is never
// included, evaluated, or used to load project configuration.
$source = stream_get_contents(STDIN);
$parser = (new ParserFactory())->createForNewestSupportedVersion();

function nodeStart(Node $node): int
{
    return max(0, $node->getStartFilePos());
}

function nodeEnd(Node $node): int
{
    return $node->getEndFilePos() < 0 ? nodeStart($node) : $node->getEndFilePos() + 1;
}

function sourceName(Node\Identifier|Node\Name|null $name): ?string
{
    return $name === null ? null : $name->toString();
}

function shortName(string $name): string
{
    $parts = explode('\\', trim($name, '\\'));
    return (string) end($parts);
}

function useKind(int $type): string
{
    return match ($type) {
        Node\Stmt\Use_::TYPE_FUNCTION => 'function',
        Node\Stmt\Use_::TYPE_CONSTANT => 'const',
        default => 'class',
    };
}

function importRecords(array $statements): array
{
    $imports = [];
    foreach ($statements as $statement) {
        if (!$statement instanceof Node\Stmt\Use_ && !$statement instanceof Node\Stmt\GroupUse) {
            continue;
        }
        $kind = useKind($statement->type);
        $prefix = $statement instanceof Node\Stmt\GroupUse ? rtrim($statement->prefix->toString(), '\\') : '';
        foreach ($statement->uses as $use) {
            $name = $use->name->toString();
            $fullName = $prefix === '' ? $name : $prefix . '\\' . $name;
            $imports[] = [
                'name' => $fullName,
                'alias' => $use->alias?->toString() ?? shortName($fullName),
                'kind' => useKind($use->type !== Node\Stmt\Use_::TYPE_UNKNOWN ? $use->type : $statement->type),
                'startByte' => nodeStart($use),
                'endByte' => nodeEnd($use),
            ];
        }
    }
    return $imports;
}

function declarations(array $statements, string $namespace, array &$supportedNodeIds): array
{
    $items = [];
    foreach ($statements as $statement) {
        if ($statement instanceof Node\Stmt\Class_ || $statement instanceof Node\Stmt\Interface_) {
            if ($statement->name === null) {
                continue;
            }
            $name = $statement->name->toString();
            $qualifiedName = $namespace === '' ? $name : $namespace . '\\' . $name;
            $kind = $statement instanceof Node\Stmt\Interface_ ? 'Interface' : 'Class';
            $supportedNodeIds[spl_object_id($statement)] = true;
            $items[] = [
                'kind' => $kind,
                'name' => $name,
                'qualifiedName' => $qualifiedName,
                'startByte' => nodeStart($statement),
                'endByte' => nodeEnd($statement),
                'parentQualifiedName' => null,
                'parentStartByte' => null,
                'parentEndByte' => null,
                'attributes' => [
                    'abstract' => $statement instanceof Node\Stmt\Class_ && $statement->isAbstract(),
                    'final' => $statement instanceof Node\Stmt\Class_ && $statement->isFinal(),
                    'readonly' => $statement instanceof Node\Stmt\Class_ && $statement->isReadonly(),
                ],
            ];

            foreach ($statement->stmts ?? [] as $member) {
                if (!$member instanceof Node\Stmt\ClassMethod) {
                    continue;
                }
                $methodName = $member->name->toString();
                $supportedNodeIds[spl_object_id($member)] = true;
                $items[] = [
                    'kind' => 'Method',
                    'name' => $methodName,
                    'qualifiedName' => $qualifiedName . '::' . $methodName,
                    'startByte' => nodeStart($member),
                    'endByte' => nodeEnd($member),
                    'parentQualifiedName' => $qualifiedName,
                    'parentStartByte' => nodeStart($statement),
                    'parentEndByte' => nodeEnd($statement),
                    'attributes' => [
                        'visibility' => $member->isPrivate() ? 'private' : ($member->isProtected() ? 'protected' : 'public'),
                        'static' => $member->isStatic(),
                        'abstract' => $member->isAbstract(),
                        'final' => $member->isFinal(),
                    ],
                ];
            }
            continue;
        }

        if ($statement instanceof Node\Stmt\Function_) {
            $supportedNodeIds[spl_object_id($statement)] = true;
            $name = $statement->name->toString();
            $items[] = [
                'kind' => 'Function',
                'name' => $name,
                'qualifiedName' => $namespace === '' ? $name : $namespace . '\\' . $name,
                'startByte' => nodeStart($statement),
                'endByte' => nodeEnd($statement),
                'parentQualifiedName' => null,
                'parentStartByte' => null,
                'parentEndByte' => null,
                'attributes' => ['byReference' => $statement->byRef],
            ];
        }
    }
    return $items;
}

function limitations(array $nodes, array $supportedNodeIds): array
{
    $found = [];
    $traverser = new NodeTraverser();
    $traverser->addVisitor(new class($found, $supportedNodeIds) extends NodeVisitorAbstract {
        private array $items = [];
        private array $supportedNodeIds;

        public function __construct(array &$items, array $supportedNodeIds)
        {
            $this->items = &$items;
            $this->supportedNodeIds = $supportedNodeIds;
        }

        public function enterNode(Node $node)
        {
            $reason = match (true) {
                $node instanceof Node\Stmt\Trait_ => 'Trait declarations are outside this adapter subset and were omitted.',
                $node instanceof Node\Stmt\Enum_ => 'Enum declarations are outside this adapter subset and were omitted.',
                $node instanceof Node\Stmt\Class_ && $node->name === null => 'Anonymous classes are outside this adapter subset and were omitted.',
                $node instanceof Node\Expr\Closure, $node instanceof Node\Expr\ArrowFunction => 'Anonymous functions and closures are outside this adapter subset and were omitted.',
                $node instanceof Node\Stmt\TraitUse => 'Trait composition is not resolved by this declaration adapter.',
                $node instanceof Node\Stmt\Property => 'Property declarations are outside this S1 declaration subset and were omitted.',
                $node instanceof Node\Param && $node->flags !== 0 => 'Constructor-promoted properties are outside this S1 declaration subset and were omitted.',
                $node instanceof Node\Stmt\ClassConst, $node instanceof Node\Stmt\Const_ => 'Constant declarations are outside this S1 declaration subset and were omitted.',
                $node instanceof Node\Stmt\InlineHTML && $node->value === "\xEF\xBB\xBF" => null,
                $node instanceof Node\Stmt\InlineHTML => 'Inline HTML is outside this PHP source subset and was not interpreted.',
                $node instanceof Node\Expr\Include_ => 'Include and require targets are not resolved by this declaration adapter.',
                $node instanceof Node\Expr\Eval_ => 'Dynamic eval code is not inspected or executed.',
                ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Interface_ || $node instanceof Node\Stmt\Function_ || $node instanceof Node\Stmt\ClassMethod) && !isset($this->supportedNodeIds[spl_object_id($node)]) => 'Nested or conditional declarations outside the direct namespace/class subset were omitted.',
                default => null,
            };
            if ($reason !== null) {
                $this->items[$reason] = true;
            }
        }
    });

    try {
        $traverser->traverse($nodes);
    } catch (Throwable) {
        // Syntax has already been accepted. A failure while scanning only
        // means unsupported constructs cannot be reported; it never executes input.
        $found['Some unsupported PHP constructs could not be classified.'] = true;
    }
    return array_keys($found);
}

try {
    $nodes = $parser->parse($source) ?? [];
    $namespaces = [];
    $supportedNodeIds = [];
    $hasNamespace = false;
    foreach ($nodes as $node) {
        if (!$node instanceof Node\Stmt\Namespace_) {
            continue;
        }
        $hasNamespace = true;
        $namespace = sourceName($node->name) ?? '';
        $namespaces[] = [
            'name' => $namespace,
            'startByte' => nodeStart($node),
            'endByte' => nodeEnd($node),
            'imports' => importRecords($node->stmts ?? []),
            'declarations' => declarations($node->stmts ?? [], $namespace, $supportedNodeIds),
        ];
    }
    if (!$hasNamespace) {
        $namespaces[] = [
            'name' => '',
            'startByte' => null,
            'endByte' => null,
            'imports' => importRecords($nodes),
            'declarations' => declarations($nodes, '', $supportedNodeIds),
        ];
    }

    $reportedLimitations = limitations($nodes, $supportedNodeIds);
    foreach ($parser->getTokens() as $token) {
        if ($token->id === T_OPEN_TAG && strncasecmp($token->text, '<?php', 5) !== 0) {
            $reportedLimitations[] = 'Short opening tags depend on target runtime configuration; declarations were parsed statically without asserting runtime compatibility.';
            break;
        }
    }

    echo json_encode([
        'valid' => true,
        'parserVersion' => Composer\InstalledVersions::getPrettyVersion('nikic/php-parser'),
        'phpVersion' => PHP_VERSION,
        'statementKinds' => array_map(static fn (Node $node): string => $node->getType(), $nodes),
        'namespaces' => $namespaces,
        'limitations' => $reportedLimitations,
        'diagnostics' => [],
    ], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
} catch (PhpParser\Error $error) {
    $errorAttributes = $error->getAttributes();
    $startByte = $errorAttributes['startFilePos'] ?? null;
    echo json_encode([
        'valid' => false,
        'parserVersion' => Composer\InstalledVersions::getPrettyVersion('nikic/php-parser'),
        'phpVersion' => PHP_VERSION,
        'statementKinds' => [],
        'namespaces' => [],
        'limitations' => [],
        'diagnostics' => [[
            'message' => $error->getRawMessage(),
            'line' => $error->getStartLine(),
            'startByte' => is_int($startByte) && $startByte >= 0 ? $startByte : null,
        ]],
    ], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
}
