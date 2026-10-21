<?php
namespace Resolver\App;
use Resolver\Contracts\{Base, Payload};
final class Factory {
  public function create(): Base { return new Base(); }
  public function check(Payload $payload): Payload { return $payload; }
}
