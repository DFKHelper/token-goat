# FORMAT-DERIVED: Nix Reference Manual "Syntax"
# (https://nix.dev/manual/nix/latest/language/syntax) and "String literals"
# (https://nix.dev/manual/nix/latest/language/string-literals) pages for comment forms
# (`#`, non-nesting `/* */`), `let ... in` bindings, and attribute-set keys. No live internet
# access was used to fetch the current published pages while writing this fixture -- it follows
# the commonly-documented Nix syntax and string-literal escaping rules described there, not this
# repo's extractor.

{ pkgs, ... }:

let
  # a let-bound name
  greeting = "hello, ${"world"}";
in
{
  services.exampleApp.enable = true;
  services.exampleApp.message = greeting;
}
