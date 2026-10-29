<?php
declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\ParserFactory;
use PhpParser\ErrorHandler\Collecting;

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

function normalizedName(Node\Name|null $name): ?string
{
    if ($name === null) {
        return null;
    }
    $resolved = $name->getAttribute('resolvedName');
    if ($resolved instanceof Node\Name) {
        return trim($resolved->toString(), '\\');
    }
    $namespaced = $name->getAttribute('namespacedName');
    if ($namespaced instanceof Node\Name) {
        return trim($namespaced->toString(), '\\');
    }
    return trim($name->toString(), '\\');
}

function declarationQualifiedName(Node\Stmt\Class_|Node\Stmt\Interface_|Node\Stmt\Function_ $node, string $namespace): string
{
    $resolved = $node->getAttribute('namespacedName');
    if ($resolved instanceof Node\Name) {
        return trim($resolved->toString(), '\\');
    }
    $name = $node->name->toString();
    return $namespace === '' ? $name : $namespace . '\\' . $name;
}

function typeNames(Node|null $type): array
{
    if ($type instanceof Node\Name) {
        return [$type];
    }
    if ($type instanceof Node\NullableType) {
        return typeNames($type->type);
    }
    if ($type instanceof Node\UnionType || $type instanceof Node\IntersectionType) {
        $items = [];
        foreach ($type->types as $part) {
            $items = array_merge($items, typeNames($part));
        }
        return $items;
    }
    return [];
}

function receiverTypeName(Node|null $type): ?Node\Name
{
    if ($type instanceof Node\Name) {
        return $type;
    }
    if ($type instanceof Node\NullableType && $type->type instanceof Node\Name) {
        return $type->type;
    }
    // Union and intersection receivers can dispatch to more than one target.
    return null;
}

function phpReference(
    string $sourceQualifiedName,
    string $sourceKind,
    string $kind,
    string $targetKind,
    ?string $targetQualifiedName,
    int $startByte,
    int $endByte,
    int $sourceStartByte,
    int $sourceEndByte,
    string $expression,
    ?string $resolutionHint = null,
    ?string $fallbackQualifiedName = null,
    ?string $reason = null,
): array {
    return [
        'sourceQualifiedName' => $sourceQualifiedName,
        'sourceKind' => $sourceKind,
        'kind' => $kind,
        'targetKind' => $targetKind,
        'targetQualifiedName' => $targetQualifiedName,
        'fallbackQualifiedName' => $fallbackQualifiedName,
        'startByte' => $startByte,
        'endByte' => $endByte,
        'sourceStartByte' => $sourceStartByte,
        'sourceEndByte' => $sourceEndByte,
        'expression' => $expression,
        'resolutionHint' => $resolutionHint,
        'reason' => $reason,
    ];
}

function phpCallableParameterFacts(array $parameters): array
{
    $facts = [];
    foreach ($parameters as $parameter) {
        if (!$parameter instanceof Node\Param) {
            continue;
        }
        $facts[] = [
            'name' => $parameter->var instanceof Node\Expr\Variable && is_string($parameter->var->name) ? $parameter->var->name : null,
            'byRef' => $parameter->byRef,
            'variadic' => $parameter->variadic,
        ];
    }
    return $facts;
}

/** Collect local callable parameter facts without executing project source. */
function phpCallableFacts(array $nodes): array
{
    $functions = [];
    $methods = [];
    $parents = [];
    $traverser = new NodeTraverser();
    $traverser->addVisitor(new class($functions, $methods, $parents) extends NodeVisitorAbstract {
        private array $functions;
        private array $methods;
        private array $parents;
        private string $namespace = '';
        private ?string $classQualifiedName = null;
        private array $scopes = [];

        public function __construct(array &$functions, array &$methods, array &$parents)
        {
            $this->functions = &$functions;
            $this->methods = &$methods;
            $this->parents = &$parents;
        }

        private function scope(): void
        {
            $this->scopes[] = [$this->namespace, $this->classQualifiedName];
        }

        private function add(array &$signatures, string $name, array $parameters): void
        {
            $key = strtolower($name);
            $signatures[$key] ??= [];
            $signatures[$key][] = phpCallableParameterFacts($parameters);
        }

        public function enterNode(Node $node)
        {
            if ($node instanceof Node\Stmt\Namespace_) {
                $this->scope();
                $this->namespace = $node->name?->toString() ?? '';
                $this->classQualifiedName = null;
            } elseif ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Interface_) {
                $this->scope();
                $this->classQualifiedName = $node->name === null ? null : declarationQualifiedName($node, $this->namespace);
                if ($this->classQualifiedName !== null) {
                    if ($node instanceof Node\Stmt\Class_ && $node->extends instanceof Node\Name) {
                        $parent = normalizedName($node->extends);
                        if ($parent !== null) {
                            $this->parents[strtolower($this->classQualifiedName)][] = $parent;
                        }
                    } elseif ($node instanceof Node\Stmt\Interface_) {
                        foreach ($node->extends as $parent) {
                            $resolved = normalizedName($parent);
                            if ($resolved !== null) {
                                $this->parents[strtolower($this->classQualifiedName)][] = $resolved;
                            }
                        }
                    }
                }
            } elseif ($node instanceof Node\Stmt\Function_) {
                $this->add($this->functions, declarationQualifiedName($node, $this->namespace), $node->params);
                $this->scope();
                $this->classQualifiedName = null;
            } elseif ($node instanceof Node\Stmt\ClassMethod && $this->classQualifiedName !== null) {
                $this->add($this->methods, $this->classQualifiedName . '::' . $node->name->toString(), $node->params);
            }
            return null;
        }

        public function leaveNode(Node $node)
        {
            if ($node instanceof Node\Stmt\Namespace_ || $node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Interface_ ||
                $node instanceof Node\Stmt\Function_) {
                $scope = array_pop($this->scopes);
                if ($scope !== null) {
                    [$this->namespace, $this->classQualifiedName] = $scope;
                }
            }
            return null;
        }
    });
    $traverser->traverse($nodes);
    return [$functions, $methods, $parents];
}

/** Extract a deliberately small, static-only set of PHP declarations and reference expressions. */
function references(array $nodes, array $namespaceFacts, array $supportedNodeIds, string $path, int $moduleEnd): array
{
    $references = [];
    $properties = [];
    $limitations = [];
    [$functionSignatures, $methodSignatures, $classParents] = phpCallableFacts($nodes);
    $traverser = new NodeTraverser();
    $traverser->addVisitor(new class($references, $properties, $limitations, $supportedNodeIds, $moduleEnd, $functionSignatures, $methodSignatures, $classParents) extends NodeVisitorAbstract {
        private array $items = [];
        private array $properties = [];
        private array $limitations = [];
        private array $functionSignatures = [];
        private array $methodSignatures = [];
        private array $classParents = [];
        private array $supportedNodeIds;
        private string $namespace = '';
        private ?string $sourceQualifiedName = null;
        private ?string $sourceKind = null;
        private ?string $classQualifiedName = null;
        private int $sourceStartByte = 0;
        private int $sourceEndByte = 0;
        private int $classStartByte = 0;
        private int $classEndByte = 0;
        private array $typedVariables = [];
        private array $referenceEscapedVariables = [];
        private int $conditionalExecutionDepth = 0;
        private array $writeProperties = [];
        private array $scopes = [];

        public function __construct(array &$items, array &$properties, array &$limitations, array $supportedNodeIds, int $moduleEnd, array $functionSignatures, array $methodSignatures, array $classParents)
        {
            $this->items = &$items;
            $this->properties = &$properties;
            $this->limitations = &$limitations;
            $this->supportedNodeIds = $supportedNodeIds;
            $this->functionSignatures = $functionSignatures;
            $this->methodSignatures = $methodSignatures;
            $this->classParents = $classParents;
            // Free top-level expressions belong to the synthetic file module.
            $this->sourceQualifiedName = '@@FILE_MODULE@@';
            $this->sourceKind = 'Module';
            $this->sourceStartByte = 0;
            $this->sourceEndByte = $moduleEnd;
        }

        private function scope(): void
        {
            $this->scopes[] = [$this->namespace, $this->sourceQualifiedName, $this->sourceKind, $this->classQualifiedName, $this->typedVariables, $this->referenceEscapedVariables, $this->sourceStartByte, $this->sourceEndByte, $this->classStartByte, $this->classEndByte, $this->conditionalExecutionDepth];
        }

        private function isConditionalExecutionNode(Node $node): bool
        {
            return $node instanceof Node\Stmt\If_ || $node instanceof Node\Stmt\ElseIf_ || $node instanceof Node\Stmt\Else_ ||
                $node instanceof Node\Stmt\While_ || $node instanceof Node\Stmt\Do_ || $node instanceof Node\Stmt\For_ ||
                $node instanceof Node\Stmt\Foreach_ || $node instanceof Node\Stmt\Switch_ || $node instanceof Node\Stmt\Case_ ||
                $node instanceof Node\Stmt\TryCatch || $node instanceof Node\Expr\Ternary || $node instanceof Node\Expr\Match_ ||
                $node instanceof Node\Expr\NullsafeMethodCall || $node instanceof Node\Expr\BinaryOp\BooleanAnd ||
                $node instanceof Node\Expr\BinaryOp\BooleanOr || $node instanceof Node\Expr\BinaryOp\LogicalAnd ||
                $node instanceof Node\Expr\BinaryOp\LogicalOr || $node instanceof Node\Expr\BinaryOp\Coalesce ||
                $node instanceof Node\Expr\AssignOp\Coalesce;
        }

        private function variablePatternNames(Node|null $node): array
        {
            if ($node instanceof Node\Expr\Variable && is_string($node->name)) {
                return [$node->name];
            }
            if ($node instanceof Node\Expr\Assign || $node instanceof Node\Expr\AssignRef || $node instanceof Node\Expr\AssignOp) {
                return $this->variablePatternNames($node->var);
            }
            if ($node instanceof Node\Expr\List_ || $node instanceof Node\Expr\Array_) {
                $names = [];
                foreach ($node->items as $item) {
                    if ($item !== null) {
                        $names = array_merge($names, $this->variablePatternNames($item->value));
                    }
                }
                return $names;
            }
            return [];
        }

        private function escapeReferenceVariables(Node|null $node): void
        {
            foreach ($this->variablePatternNames($node) as $name) {
                unset($this->typedVariables[$name]);
                $this->referenceEscapedVariables[$name] = true;
            }
        }

        private function hasByReferenceParameter(array $signature, int $position): bool
        {
            $parameter = $signature[$position] ?? null;
            if ($parameter !== null) {
                return $parameter['byRef'];
            }
            $last = $signature === [] ? null : $signature[array_key_last($signature)];
            return $last !== null && $last['variadic'] && $last['byRef'];
        }

        private function hasByReferenceParameterNamed(array $signature, string $name): bool
        {
            foreach ($signature as $parameter) {
                if ($parameter['name'] === $name) {
                    return $parameter['byRef'];
                }
            }
            $last = $signature === [] ? null : $signature[array_key_last($signature)];
            return $last !== null && $last['variadic'] && $last['byRef'];
        }

        private function hasByReferenceParameterAfter(array $signature, int $position): bool
        {
            foreach ($signature as $index => $parameter) {
                if ($index >= $position && $parameter['byRef']) {
                    return true;
                }
            }
            $last = $signature === [] ? null : $signature[array_key_last($signature)];
            return $last !== null && $last['variadic'] && $last['byRef'];
        }

        private function escapeByReferenceArguments(array $arguments, array $signatures): void
        {
            $position = 0;
            $positionUnknown = false;
            foreach ($arguments as $argument) {
                if (!$argument instanceof Node\Arg) {
                    continue;
                }
                $mayPassByReference = false;
                foreach ($signatures as $signature) {
                    if ($argument->unpack) {
                        $mayPassByReference = $mayPassByReference || $this->hasByReferenceParameterAfter($signature, $position);
                    } elseif ($argument->name instanceof Node\Identifier) {
                        $mayPassByReference = $mayPassByReference || $this->hasByReferenceParameterNamed($signature, $argument->name->toString());
                    } elseif ($positionUnknown) {
                        $mayPassByReference = $mayPassByReference || $this->hasByReferenceParameterAfter($signature, $position);
                    } else {
                        $mayPassByReference = $mayPassByReference || $this->hasByReferenceParameter($signature, $position);
                    }
                }
                if ($mayPassByReference) {
                    $this->escapeReferenceVariables($argument->value);
                }
                if ($argument->unpack) {
                    $positionUnknown = true;
                } elseif ($argument->name === null && !$positionUnknown) {
                    $position++;
                }
            }
        }

        private function escapeAllArguments(array $arguments): void
        {
            foreach ($arguments as $argument) {
                if ($argument instanceof Node\Arg) {
                    $this->escapeReferenceVariables($argument->value);
                }
            }
        }

        private function methodSignatures(string $className, string $methodName, array $visited = []): array
        {
            $classKey = strtolower($className);
            if (isset($visited[$classKey])) {
                return [];
            }
            $visited[$classKey] = true;
            $signatures = $this->methodSignatures[strtolower($className . '::' . $methodName)] ?? [];
            foreach ($this->classParents[$classKey] ?? [] as $parent) {
                $signatures = array_merge($signatures, $this->methodSignatures($parent, $methodName, $visited));
            }
            return $signatures;
        }

        private function methodReceiverClass(Node\Expr $receiver): ?string
        {
            if ($receiver instanceof Node\Expr\Variable && $receiver->name === 'this') {
                return $this->classQualifiedName;
            }
            if ($receiver instanceof Node\Expr\Variable && is_string($receiver->name)) {
                return $this->typedVariables[$receiver->name] ?? null;
            }
            return null;
        }

        private function invalidateVariables(Node|null $node): void
        {
            foreach ($this->variablePatternNames($node) as $name) {
                unset($this->typedVariables[$name]);
            }
        }

        private function add(
            string $kind,
            string $targetKind,
            ?string $target,
            Node $evidence,
            string $expression,
            ?string $hint = null,
            ?string $fallback = null,
            ?string $reason = null,
            ?string $sourceName = null,
            ?string $sourceKind = null,
        ): void {
            if ($this->sourceQualifiedName === null && $sourceName === null) {
                return;
            }
            $start = nodeStart($evidence);
            $end = nodeEnd($evidence);
            if ($end <= $start) {
                return;
            }
            $this->items[] = phpReference(
                $sourceName ?? $this->sourceQualifiedName,
                $sourceKind ?? $this->sourceKind,
                $kind,
                $targetKind,
                $target,
                $start,
                $end,
                $sourceName === null || $sourceName === $this->sourceQualifiedName ? $this->sourceStartByte : 0,
                $sourceName === null || $sourceName === $this->sourceQualifiedName ? $this->sourceEndByte : 0,
                $expression,
                $hint,
                $fallback,
                $reason,
            );
        }

        private function addPropertyWrite(Node\Expr\PropertyFetch|Node\Expr\StaticPropertyFetch $fetch): void
        {
            $static = $fetch instanceof Node\Expr\StaticPropertyFetch;
            $property = $static
                ? ($fetch->name instanceof Node\VarLikeIdentifier ? $fetch->name->toString() : null)
                : ($fetch->name instanceof Node\Identifier ? $fetch->name->toString() : null);
            $receiver = null;
            $hint = 'property-write';
            if ($static) {
                $classToken = $fetch->class instanceof Node\Name ? strtolower($fetch->class->toString()) : '';
                $receiver = $fetch->class instanceof Node\Name ? $this->className($fetch->class) : null;
                if ($classToken === 'parent') {
                    $receiver = 'parent';
                }
                $hint = $classToken === 'static' ? 'late-static-property-write'
                    : ($classToken === 'parent' ? 'parent-static-property-write' : 'static-property-write');
            } elseif ($fetch->var instanceof Node\Expr\Variable && $fetch->var->name === 'this') {
                $receiver = $this->classQualifiedName;
            } elseif ($fetch->var instanceof Node\Expr\Variable && is_string($fetch->var->name)) {
                $receiver = $this->typedVariables[$fetch->var->name] ?? null;
            }
            $target = $receiver !== null && $property !== null ? $receiver . '.' . $property : null;
            $reason = $target === null ? ($receiver === null ? 'UNKNOWN_RECEIVER' : 'UNSUPPORTED_CONSTRUCT') : null;
            $this->add('WRITES', 'Property', $target, $fetch->name instanceof Node ? $fetch->name : $fetch,
                $fetch->getType(), $hint, null, $reason);
        }

        private function className(Node\Name $name): ?string
        {
            $resolved = normalizedName($name);
            if ($resolved === null) {
                return null;
            }
            $lower = strtolower($name->toString());
            if ($lower === 'self' || $lower === 'static') {
                return $this->classQualifiedName;
            }
            if ($lower === 'parent') {
                return null;
            }
            return $resolved;
        }

        private function addType(Node|null $type, string $sourceName, string $sourceKind): void
        {
            foreach (typeNames($type) as $name) {
                $target = $this->className($name);
                if ($target === null) {
                    if (strtolower($name->toString()) === 'parent' && $this->classQualifiedName !== null) {
                        $this->add('TYPE_REFERENCES', 'Class', null, $name, $name->toString(), 'parent-type', null, 'UNSUPPORTED_CONSTRUCT', $sourceName, $sourceKind);
                    }
                    continue;
                }
                $this->add('TYPE_REFERENCES', 'Class', $target, $name, $name->toString(), 'type', null, null, $sourceName, $sourceKind);
            }
        }

        public function enterNode(Node $node)
        {
            if ($this->isConditionalExecutionNode($node)) {
                $this->conditionalExecutionDepth++;
            }

            if ($node instanceof Node\Stmt\Namespace_) {
                $this->scope();
                $this->namespace = $node->name?->toString() ?? '';
                $namespaceSuffix = $node->name === null ? '#namespace:(global)' : '#namespace:' . $this->namespace;
                $this->sourceQualifiedName = '@@FILE_MODULE@@' . $namespaceSuffix;
                $this->sourceKind = 'Module';
                $this->sourceStartByte = nodeStart($node);
                $this->sourceEndByte = nodeEnd($node);
                $this->classQualifiedName = null;
                $this->typedVariables = [];
                $this->referenceEscapedVariables = [];
                return null;
            }

            if ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Interface_) {
                $this->scope();
                if ($node->name === null || !isset($this->supportedNodeIds[spl_object_id($node)])) {
                    $this->sourceQualifiedName = null;
                    $this->sourceKind = null;
                    $this->classQualifiedName = null;
                    $this->typedVariables = [];
                    return NodeTraverser::DONT_TRAVERSE_CHILDREN;
                }
                $this->classQualifiedName = declarationQualifiedName($node, $this->namespace);
                $this->sourceQualifiedName = $this->classQualifiedName;
                $this->sourceKind = $node instanceof Node\Stmt\Interface_ ? 'Interface' : 'Class';
                $this->sourceStartByte = nodeStart($node);
                $this->sourceEndByte = nodeEnd($node);
                $this->classStartByte = $this->sourceStartByte;
                $this->classEndByte = $this->sourceEndByte;
                $this->typedVariables = [];
                $this->referenceEscapedVariables = [];
                if ($node instanceof Node\Stmt\Class_ && $node->extends instanceof Node\Name) {
                    $target = $this->className($node->extends);
                    $this->add('EXTENDS', 'Class', $target, $node->extends, $node->extends->toString(), 'class-name');
                }
                if ($node instanceof Node\Stmt\Class_) {
                    foreach ($node->implements as $implemented) {
                        $target = $this->className($implemented);
                        $this->add('IMPLEMENTS', 'Interface', $target, $implemented, $implemented->toString(), 'class-name');
                    }
                } else {
                    foreach ($node->extends as $parent) {
                        $target = $this->className($parent);
                        $this->add('EXTENDS', 'Interface', $target, $parent, $parent->toString(), 'class-name');
                    }
                }
                return null;
            }

            if ($node instanceof Node\Stmt\ClassMethod) {
                $this->scope();
                if (!isset($this->supportedNodeIds[spl_object_id($node)]) || $this->classQualifiedName === null) {
                    $this->sourceQualifiedName = null;
                    $this->sourceKind = null;
                    $this->typedVariables = [];
                    return NodeTraverser::DONT_TRAVERSE_CHILDREN;
                }
                $this->sourceQualifiedName = $this->classQualifiedName . '::' . $node->name->toString();
                $this->sourceKind = 'Method';
                $this->sourceStartByte = nodeStart($node);
                $this->sourceEndByte = nodeEnd($node);
                $this->typedVariables = [];
                $this->referenceEscapedVariables = [];
                $this->conditionalExecutionDepth = 0;
                foreach ($node->params as $parameter) {
                    $variable = $parameter->var instanceof Node\Expr\Variable && is_string($parameter->var->name) ? $parameter->var->name : null;
                    $receiverType = receiverTypeName($parameter->type);
                    $this->addType($parameter->type, $this->sourceQualifiedName, 'Method');
                    if ($variable !== null && $receiverType !== null) {
                        $resolved = $this->className($receiverType);
                        if ($resolved !== null) {
                            $this->typedVariables[$variable] = $resolved;
                        }
                    }
                }
                $this->addType($node->returnType, $this->sourceQualifiedName, 'Method');
                return null;
            }

            if ($node instanceof Node\Stmt\Function_) {
                $this->scope();
                if (!isset($this->supportedNodeIds[spl_object_id($node)])) {
                    $this->sourceQualifiedName = null;
                    $this->sourceKind = null;
                    $this->classQualifiedName = null;
                    $this->typedVariables = [];
                    return NodeTraverser::DONT_TRAVERSE_CHILDREN;
                }
                $this->sourceQualifiedName = declarationQualifiedName($node, $this->namespace);
                $this->sourceKind = 'Function';
                $this->sourceStartByte = nodeStart($node);
                $this->sourceEndByte = nodeEnd($node);
                $this->classQualifiedName = null;
                $this->typedVariables = [];
                $this->referenceEscapedVariables = [];
                $this->conditionalExecutionDepth = 0;
                foreach ($node->params as $parameter) {
                    $variable = $parameter->var instanceof Node\Expr\Variable && is_string($parameter->var->name) ? $parameter->var->name : null;
                    $receiverType = receiverTypeName($parameter->type);
                    $this->addType($parameter->type, $this->sourceQualifiedName, 'Function');
                    if ($variable !== null && $receiverType !== null) {
                        $resolved = $this->className($receiverType);
                        if ($resolved !== null) {
                            $this->typedVariables[$variable] = $resolved;
                        }
                    }
                }
                $this->addType($node->returnType, $this->sourceQualifiedName, 'Function');
                return null;
            }

            if ($node instanceof Node\Expr\Closure || $node instanceof Node\Expr\ArrowFunction) {
                if ($node instanceof Node\Expr\Closure) {
                    foreach ($node->uses as $use) {
                        if ($use->byRef && $use->var instanceof Node\Expr\Variable && is_string($use->var->name)) {
                            $this->escapeReferenceVariables($use->var);
                        }
                    }
                }
                $this->scope();
                $this->sourceQualifiedName = null;
                $this->sourceKind = null;
                $this->typedVariables = [];
                $this->referenceEscapedVariables = [];
                return NodeTraverser::DONT_TRAVERSE_CHILDREN;
            }

            if ($node instanceof Node\Stmt\Property && $this->classQualifiedName !== null) {
                $visibility = $node->isPrivate() ? 'private' : ($node->isProtected() ? 'protected' : 'public');
                foreach ($node->props as $property) {
                    $name = $property->name->toString();
                    $this->properties[] = [
                        'name' => $name,
                        'qualifiedName' => $this->classQualifiedName . '.' . $name,
                        'parentQualifiedName' => $this->classQualifiedName,
                        'parentStartByte' => $this->classStartByte,
                        'parentEndByte' => $this->classEndByte,
                        'startByte' => nodeStart($property->name),
                        'endByte' => nodeEnd($property->name),
                        'attributes' => [
                            'visibility' => $visibility,
                            'static' => $node->isStatic(),
                            'readonly' => $node->isReadonly(),
                        ],
                    ];
                }
                if ($node->type !== null) {
                    foreach ($node->props as $property) {
                        $this->addType($node->type, $this->classQualifiedName, $this->sourceKind ?? 'Class');
                    }
                }
                return NodeTraverser::DONT_TRAVERSE_CHILDREN;
            }

            if ($node instanceof Node\Param && $node->flags !== 0 && $this->classQualifiedName !== null &&
                $node->var instanceof Node\Expr\Variable && is_string($node->var->name)) {
                $name = $node->var->name;
                $flags = $node->flags;
                $this->properties[] = [
                    'name' => $name,
                    'qualifiedName' => $this->classQualifiedName . '.' . $name,
                    'parentQualifiedName' => $this->classQualifiedName,
                    'parentStartByte' => $this->classStartByte,
                    'parentEndByte' => $this->classEndByte,
                    'startByte' => nodeStart($node->var),
                    'endByte' => nodeEnd($node->var),
                    'attributes' => [
                        'visibility' => ($flags & Node\Stmt\Class_::MODIFIER_PRIVATE) !== 0 ? 'private' : (($flags & Node\Stmt\Class_::MODIFIER_PROTECTED) !== 0 ? 'protected' : 'public'),
                        'static' => false,
                        'readonly' => ($flags & Node\Stmt\Class_::MODIFIER_READONLY) !== 0,
                        'parameterProperty' => true,
                    ],
                ];
            }

            if ($this->sourceQualifiedName === null) {
                return null;
            }

            if ($node instanceof Node\Expr\Assign || $node instanceof Node\Expr\AssignRef || $node instanceof Node\Expr\AssignOp) {
                $this->invalidateVariables($node->var);
                if ($node instanceof Node\Expr\AssignRef) {
                    $this->escapeReferenceVariables($node->var);
                    $this->escapeReferenceVariables($node->expr);
                }
            } elseif ($node instanceof Node\Stmt\Foreach_) {
                $this->invalidateVariables($node->keyVar);
                $this->invalidateVariables($node->valueVar);
                if ($node->byRef || $node->valueVar instanceof Node\Expr\AssignRef) {
                    $this->escapeReferenceVariables($node->valueVar);
                }
            } elseif ($node instanceof Node\Stmt\Unset_) {
                foreach ($node->vars as $variable) {
                    $this->invalidateVariables($variable);
                    if ($variable instanceof Node\Expr\PropertyFetch || $variable instanceof Node\Expr\StaticPropertyFetch) {
                        $this->writeProperties[spl_object_id($variable)] = true;
                        $this->addPropertyWrite($variable);
                    }
                }
            } elseif ($node instanceof Node\Stmt\Catch_) {
                $this->invalidateVariables($node->var);
            } elseif ($node instanceof Node\Stmt\Global_) {
                foreach ($node->vars as $variable) $this->escapeReferenceVariables($variable);
            }

            if ($node instanceof Node\Expr\New_ && $node->class instanceof Node\Name) {
                $target = $this->className($node->class);
                $constructorSignatures = $target === null ? [] : $this->methodSignatures($target, '__construct');
                if ($constructorSignatures === []) {
                    $this->escapeAllArguments($node->args);
                } else {
                    $this->escapeByReferenceArguments($node->args, $constructorSignatures);
                }
                $this->add('INSTANTIATES', 'Class', $target, $node->class, $node->class->toString(), 'class-name');
            } elseif ($node instanceof Node\Expr\New_) {
                $this->escapeAllArguments($node->args);
            } elseif ($node instanceof Node\Expr\FuncCall) {
                if ($node->name instanceof Node\Name) {
                    $targetName = normalizedName($node->name);
                    $signatures = $targetName === null ? [] : ($this->functionSignatures[strtolower($targetName)] ?? []);
                    $rawName = trim($node->name->toString(), '\\');
                    if ($signatures === [] && !str_contains($rawName, '\\') && !$node->name->isFullyQualified() && !$node->name->isRelative()) {
                        $localName = $this->namespace === '' ? $rawName : $this->namespace . '\\' . $rawName;
                        $signatures = $this->functionSignatures[strtolower($localName)] ?? [];
                    }
                    if ($signatures === [] && !str_contains($rawName, '\\') && !$node->name->isFullyQualified() && !$node->name->isRelative()) {
                        $signatures = $this->functionSignatures[strtolower($rawName)] ?? [];
                    }
                    if ($signatures === []) {
                        $this->escapeAllArguments($node->args);
                    } else {
                        $this->escapeByReferenceArguments($node->args, $signatures);
                    }
                } else {
                    $this->escapeAllArguments($node->args);
                }
                if ($node->name instanceof Node\Name) {
                    $target = normalizedName($node->name);
                    $fallback = null;
                    $raw = trim($node->name->toString(), '\\');
                    if (!$node->name->getAttribute('resolvedName') instanceof Node\Name && !str_contains($raw, '\\') && !$node->name->isFullyQualified() && !$node->name->isRelative()) {
                        $fallback = $raw;
                    }
                    $this->add('CALLS', 'Function', $target, $node->name, $node->name->toString(), 'function', $fallback);
                } else {
                    $this->add('CALLS', 'Function', null, $node, $node->getType(), 'dynamic', null, 'DYNAMIC_LOAD');
                }
            } elseif ($node instanceof Node\Expr\StaticCall) {
                $method = $node->name instanceof Node\Identifier ? $node->name->toString() : null;
                $classToken = $node->class instanceof Node\Name ? strtolower($node->class->toString()) : '';
                $class = $node->class instanceof Node\Name ? $this->className($node->class) : null;
                if ($classToken === 'parent' && $this->classQualifiedName !== null) {
                    $class = $this->classParents[strtolower($this->classQualifiedName)][0] ?? null;
                }
                if ($class !== null && $method !== null) {
                    $signatures = $this->methodSignatures($class, $method);
                    if ($signatures === []) {
                        $this->escapeAllArguments($node->args);
                    } else {
                        $this->escapeByReferenceArguments($node->args, $signatures);
                    }
                } else {
                    $this->escapeAllArguments($node->args);
                }
                $hint = $classToken === 'static' ? 'late-static' : ($classToken === 'parent' ? 'parent-static' : 'static');
                if ($classToken === 'parent') {
                    $class = 'parent';
                }
                $target = $class !== null && $method !== null ? $class . '::' . $method : null;
                $reason = $target === null ? 'UNSUPPORTED_CONSTRUCT' : null;
                $this->add('CALLS', 'Method', $target, $node->name instanceof Node ? $node->name : $node, $node->name instanceof Node ? $node->name->toString() : $node->getType(), $hint, null, $reason);
            } elseif ($node instanceof Node\Expr\NullsafeMethodCall) {
                $this->escapeAllArguments($node->args);
            } elseif ($node instanceof Node\Expr\MethodCall) {
                $method = $node->name instanceof Node\Identifier ? $node->name->toString() : null;
                $receiverClass = $this->methodReceiverClass($node->var);
                $signatures = $receiverClass !== null && $method !== null ? $this->methodSignatures($receiverClass, $method) : [];
                if ($signatures === []) {
                    $this->escapeAllArguments($node->args);
                } else {
                    $this->escapeByReferenceArguments($node->args, $signatures);
                }
                $targetClass = null;
                $hint = 'instance';
                if ($node->var instanceof Node\Expr\Variable && $node->var->name === 'this') {
                    $targetClass = $this->classQualifiedName;
                    $hint = 'instance-this';
                } elseif ($node->var instanceof Node\Expr\Variable && is_string($node->var->name)) {
                    $targetClass = $this->typedVariables[$node->var->name] ?? null;
                    $hint = $targetClass === null ? 'unknown-receiver' : 'typed-receiver';
                }
                $target = $targetClass !== null && $method !== null ? $targetClass . '::' . $method : null;
                $expression = $node->var instanceof Node\Expr\Variable && is_string($node->var->name)
                    ? '$' . $node->var->name . '->' . ($method ?? '{dynamic}') . '()'
                    : $node->getType();
                $reason = $target === null ? ($method === null ? 'UNSUPPORTED_CONSTRUCT' : 'UNKNOWN_RECEIVER') : null;
                $this->add('CALLS', 'Method', $target, $node->name instanceof Node ? $node->name : $node, $expression, $hint, null, $reason);
            } elseif ($node instanceof Node\Expr\PropertyFetch) {
                $property = $node->name instanceof Node\Identifier ? $node->name->toString() : null;
                $receiver = null;
                if ($node->var instanceof Node\Expr\Variable && $node->var->name === 'this') {
                    $receiver = $this->classQualifiedName;
                } elseif ($node->var instanceof Node\Expr\Variable && is_string($node->var->name)) {
                    $receiver = $this->typedVariables[$node->var->name] ?? null;
                }
                if (!isset($this->writeProperties[spl_object_id($node)])) {
                    $target = $receiver !== null && $property !== null ? $receiver . '.' . $property : null;
                    $reason = $target === null ? ($property === null ? 'UNSUPPORTED_CONSTRUCT' : 'UNKNOWN_RECEIVER') : null;
                    $this->add('READS', 'Property', $target, $node->name instanceof Node ? $node->name : $node, $node->getType(), 'property', null, $reason);
                }
                unset($this->writeProperties[spl_object_id($node)]);
            } elseif (($node instanceof Node\Expr\Assign || $node instanceof Node\Expr\AssignRef) &&
                ($node->var instanceof Node\Expr\PropertyFetch || $node->var instanceof Node\Expr\StaticPropertyFetch)) {
                $this->writeProperties[spl_object_id($node->var)] = true;
                $this->addPropertyWrite($node->var);
            } elseif ($node instanceof Node\Expr\AssignOp && ($node->var instanceof Node\Expr\PropertyFetch || $node->var instanceof Node\Expr\StaticPropertyFetch)) {
                // Compound assignments both read the previous value (handled by the fetch node) and write it.
                $this->addPropertyWrite($node->var);
            } elseif (($node instanceof Node\Expr\PreInc || $node instanceof Node\Expr\PostInc ||
                $node instanceof Node\Expr\PreDec || $node instanceof Node\Expr\PostDec) &&
                ($node->var instanceof Node\Expr\PropertyFetch || $node->var instanceof Node\Expr\StaticPropertyFetch)) {
                // Increment/decrement reads the previous value and writes the updated value.
                $this->addPropertyWrite($node->var);
            } elseif ($node instanceof Node\Expr\StaticPropertyFetch) {
                $property = $node->name instanceof Node\VarLikeIdentifier ? $node->name->toString() : null;
                $classToken = $node->class instanceof Node\Name ? strtolower($node->class->toString()) : '';
                $class = $node->class instanceof Node\Name ? $this->className($node->class) : null;
                $hint = $classToken === 'static' ? 'late-static-property' : ($classToken === 'parent' ? 'parent-static-property' : 'static-property');
                if ($classToken === 'parent') {
                    $class = 'parent';
                }
                if (!isset($this->writeProperties[spl_object_id($node)])) {
                    $target = $class !== null && $property !== null ? $class . '.' . $property : null;
                    $reason = $target === null ? ($class === null ? 'UNKNOWN_RECEIVER' : 'UNSUPPORTED_CONSTRUCT') : null;
                    $this->add('READS', 'Property', $target, $node->name instanceof Node ? $node->name : $node, $node->getType(), $hint, null, $reason);
                }
                unset($this->writeProperties[spl_object_id($node)]);
            } elseif ($node instanceof Node\Expr\Instanceof_ && $node->class instanceof Node\Name) {
                $target = $this->className($node->class);
                $this->add('TYPE_REFERENCES', 'Class', $target, $node->class, $node->class->toString(), 'class-name');
            } elseif ($node instanceof Node\Stmt\Catch_) {
                foreach ($node->types as $type) {
                    $target = $this->className($type);
                    $this->add('TYPE_REFERENCES', 'Class', $target, $type, $type->toString(), 'type');
                }
            }

            return null;
        }

        public function leaveNode(Node $node)
        {
            // A local variable receives a statically known receiver type only
            // after an unconditional, straight-line assignment from `new`.
            // Assignments inside branches, loops, short-circuit expressions,
            // and try/catch regions are intentionally left unknown.
            if ($node instanceof Node\Expr\Assign && $this->conditionalExecutionDepth === 0 &&
                ($this->sourceKind === 'Function' || $this->sourceKind === 'Method') &&
                $node->var instanceof Node\Expr\Variable && is_string($node->var->name) &&
                !isset($this->referenceEscapedVariables[$node->var->name]) &&
                $node->expr instanceof Node\Expr\New_ && $node->expr->class instanceof Node\Name) {
                $resolved = $this->className($node->expr->class);
                if ($resolved !== null) {
                    $this->typedVariables[$node->var->name] = $resolved;
                }
            }

            if ($this->isConditionalExecutionNode($node)) {
                $this->conditionalExecutionDepth = max(0, $this->conditionalExecutionDepth - 1);
            }

            if ($node instanceof Node\Stmt\Namespace_ || $node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Interface_ ||
                $node instanceof Node\Stmt\Function_ || $node instanceof Node\Stmt\ClassMethod ||
                $node instanceof Node\Expr\Closure || $node instanceof Node\Expr\ArrowFunction) {
                $scope = array_pop($this->scopes);
                if ($scope !== null) {
                    [$this->namespace, $this->sourceQualifiedName, $this->sourceKind, $this->classQualifiedName, $this->typedVariables, $this->referenceEscapedVariables] = $scope;
                    [$this->sourceStartByte, $this->sourceEndByte, $this->classStartByte, $this->classEndByte, $this->conditionalExecutionDepth] = array_slice($scope, 6);
                }
            }
            return null;
        }
    });

    try {
        $traverser->traverse($nodes);
    } catch (Throwable) {
        $limitations[] = 'Some PHP reference expressions could not be classified by the static AST visitor.';
    }

    foreach ($namespaceFacts as $namespace) {
        $namespaceName = (string) ($namespace['name'] ?? '');
        $sourceQualifiedName = $namespaceName === '' ? $path : $path . '#namespace:' . $namespaceName;
        $sourceStartByte = is_int($namespace['startByte'] ?? null) ? $namespace['startByte'] : 0;
        $sourceEndByte = is_int($namespace['endByte'] ?? null) ? $namespace['endByte'] : $moduleEnd;
        foreach (($namespace['imports'] ?? []) as $import) {
            if (!is_array($import) || !isset($import['name'], $import['kind'], $import['startByte'], $import['endByte'])) {
                continue;
            }
            $importKind = $import['kind'];
            $targetKind = $importKind === 'class' ? 'Class' : ($importKind === 'function' ? 'Function' : 'Constant');
            $target = trim((string) $import['name'], '\\');
            $kind = 'IMPORTS';
            $reason = $importKind === 'const' ? 'UNSUPPORTED_CONSTRUCT' : null;
            $start = (int) $import['startByte'];
            $end = (int) $import['endByte'];
            if ($end <= $start) {
                continue;
            }
            $references[] = phpReference(
                $sourceQualifiedName,
                'Module',
                $kind,
                $targetKind,
                $target,
                $start,
                $end,
                $sourceStartByte,
                $sourceEndByte,
                (string) $import['name'],
                'import',
                null,
                $reason,
            );
        }
    }
    return ['references' => $references, 'properties' => $properties, 'limitations' => array_values(array_unique($limitations))];
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
    $nameResolutionLimitations = [];
    try {
        $nameTraverser = new NodeTraverser();
        $nameTraverser->addVisitor(new NameResolver(new Collecting(), ['replaceNodes' => false]));
        $nodes = $nameTraverser->traverse($nodes);
    } catch (Throwable) {
        $nameResolutionLimitations[] = 'Name alias resolution was unavailable for one or more PHP names; affected references remain unresolved.';
    }
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

    $reportedLimitations = array_merge(limitations($nodes, $supportedNodeIds), $nameResolutionLimitations);
    foreach ($parser->getTokens() as $token) {
        if ($token->id === T_OPEN_TAG && strncasecmp($token->text, '<?php', 5) !== 0) {
            $reportedLimitations[] = 'Short opening tags depend on target runtime configuration; declarations were parsed statically without asserting runtime compatibility.';
            break;
        }
    }
    $referenceFacts = references($nodes, $namespaces, $supportedNodeIds, '', strlen($source));

    // The module path is assigned by the TypeScript caller, so replace the
    // empty global module source with the source path in the response wrapper.
    foreach ($referenceFacts['references'] as &$reference) {
        if (($reference['sourceKind'] ?? null) === 'Module' && ($reference['sourceQualifiedName'] ?? null) === '') {
            $reference['sourceQualifiedName'] = '@@FILE_MODULE@@';
        } elseif (($reference['sourceKind'] ?? null) === 'Module' && str_starts_with((string) ($reference['sourceQualifiedName'] ?? ''), '#namespace:')) {
            $reference['sourceQualifiedName'] = '@@FILE_MODULE@@' . $reference['sourceQualifiedName'];
        }
    }
    unset($reference);

    echo json_encode([
        'valid' => true,
        'parserVersion' => Composer\InstalledVersions::getPrettyVersion('nikic/php-parser'),
        'phpVersion' => PHP_VERSION,
        'statementKinds' => array_map(static fn (Node $node): string => $node->getType(), $nodes),
        'namespaces' => $namespaces,
        'references' => $referenceFacts['references'],
        'properties' => $referenceFacts['properties'],
        'referenceLimitations' => $referenceFacts['limitations'],
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
        'references' => [],
        'properties' => [],
        'referenceLimitations' => [],
        'limitations' => [],
        'diagnostics' => [[
            'message' => $error->getRawMessage(),
            'line' => $error->getStartLine(),
            'startByte' => is_int($startByte) && $startByte >= 0 ? $startByte : null,
        ]],
    ], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
}
