// CAPTURE: literal output of `node node_modules/eslint/bin/eslint.js --no-config-lookup -c eslint.config.js src` (eslint 10.10.0, stylish formatter) run against 40 synthetic files, each carrying six `const vN = N;` unused-var errors (no-unused-vars) plus one `if (a == 1) { console.log(1) }` line producing three warnings (no-undef x2, eqeqeq x1); eslint.config.js sets those three rules on src/**/*.js. 443 raw lines, 240 errors, 120 warnings, exit code 1. The absolute Windows temp path the run produced (C:\Users\<user>\AppData\Local\Temp\tg-eslint-probe\src\) has been rewritten to /home/u/proj/src/ for a stable fixture; no other byte was touched.

export const CAPTURE_ESLINT_40_FILES = `
/home/u/proj/src/mod0.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod1.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod10.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod11.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod12.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod13.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod14.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod15.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod16.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod17.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod18.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod19.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod2.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod20.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod21.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod22.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod23.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod24.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod25.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod26.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod27.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod28.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod29.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod3.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod30.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod31.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod32.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod33.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod34.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod35.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod36.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod37.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod38.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod39.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod4.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod5.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod6.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod7.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod8.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

/home/u/proj/src/mod9.js
  1:7   error    'v0' is assigned a value but never used  no-unused-vars
  2:7   error    'v1' is assigned a value but never used  no-unused-vars
  3:7   error    'v2' is assigned a value but never used  no-unused-vars
  4:7   error    'v3' is assigned a value but never used  no-unused-vars
  5:7   error    'v4' is assigned a value but never used  no-unused-vars
  6:7   error    'v5' is assigned a value but never used  no-unused-vars
  7:5   warning  'a' is not defined                       no-undef
  7:7   warning  Expected '===' and instead saw '=='      eqeqeq
  7:15  warning  'console' is not defined                 no-undef

✖ 360 problems (240 errors, 120 warnings)
`
