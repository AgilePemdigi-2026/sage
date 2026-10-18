<?php
namespace Contracts;
interface Renderable { public function render(): string; }
class Base { protected string $label = "layanan"; }
