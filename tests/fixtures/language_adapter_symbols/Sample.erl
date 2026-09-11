%% FORMAT-DERIVED: Erlang Reference Manual, function declarations https://www.erlang.org/doc/system/ref_man_functions.html
-module(sample).
-export([fact/1, area/1]).
-include("sample.hrl").
-include_lib("kernel/include/file.hrl").
-import(lists, [reverse/1]).

-define(MAX_TRIES, 3).
-record(point, {x = 0, y = 0}).
-type shape() :: {circle, number()} | {square, number()}.

%% fact/1, written as the reference manual writes it.
fact(N) when N > 0 ->  % first clause head
    N * fact(N-1);     % first clause body

fact(0) ->             % second clause head
    1.                 % second clause body

area({circle, R}) ->
    3.14159 * R * R;
area({square, S}) ->
    S * S.

quoted() ->
    "a period. inside a string",
    'an atom. with a period',
    $.,
    ok.
