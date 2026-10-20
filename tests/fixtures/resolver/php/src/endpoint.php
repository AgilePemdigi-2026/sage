<?php
namespace Resolver\App;
use Resolver\Contracts\Base;
use Resolver\Contracts\Payload;
use Resolver\Contracts\Missing;
use function Resolver\Contracts\describe;
class Endpoint extends Base implements Payload {
  public function value(): string { return describe("café"); }
}
function uncertain(object $input): mixed { return $input->run(); }
