<?php
declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

// Source is read as data from stdin; it is never included or evaluated.
$source = stream_get_contents(STDIN);
$parser = (new PhpParser\ParserFactory())->createForNewestSupportedVersion();
try {
    $nodes = $parser->parse($source);
    echo json_encode([
        'valid' => true,
        'parserVersion' => Composer\InstalledVersions::getPrettyVersion('nikic/php-parser'),
        'phpVersion' => PHP_VERSION,
        'statementKinds' => array_map(fn($node) => $node->getType(), $nodes ?? []),
        'diagnostics' => [],
    ], JSON_THROW_ON_ERROR);
} catch (PhpParser\Error $error) {
    echo json_encode(['valid' => false, 'diagnostics' => [['message' => $error->getRawMessage(), 'line' => $error->getStartLine()]]], JSON_THROW_ON_ERROR);
}
