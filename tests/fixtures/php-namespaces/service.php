<?php
namespace App;
use Contracts\Base;
use Contracts\Renderable;
throw new \RuntimeException("FIXTURE_MUST_NOT_EXECUTE");
class Service extends Base implements Renderable {
    public function render(): string { return $this->label; }
}
function callUnknown(object $target): mixed { return $target->run(); }
