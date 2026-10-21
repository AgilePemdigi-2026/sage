<?php
if (getenv('SAGE_RESOLVER_CANARY_PATH')) {
    file_put_contents(getenv('SAGE_RESOLVER_CANARY_PATH'), 'PHP source executed');
}
throw new \RuntimeException('SAGE_RESOLVER_PHP_CANARY_MUST_NOT_EXECUTE');
