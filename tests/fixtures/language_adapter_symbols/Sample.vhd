-- FORMAT-DERIVED: IEEE Std 1076-2008 clauses 3.2 (entity_declaration), 3.3 (architecture_body),
-- 4.7/4.8 (package_declaration, package_body) and 4.2/4.3 (subprogram_body: function, procedure);
-- this fixture follows those grammar productions, not this repo's extractor.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

/* A synchronous up counter with an asynchronous reset, per 1076-2008 15.9 a delimited
   comment like this one does NOT nest -- the first closing "*\/" ends it. */
entity counter is
  generic (
    WIDTH : integer := 4
  );
  port (
    clk   : in  std_logic;
    rst   : in  std_logic;
    count : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity counter;

architecture rtl of counter is
  signal count_reg : unsigned(WIDTH - 1 downto 0) := (others => '0');
begin
  count <= std_logic_vector(count_reg);

  count_proc : process (clk, rst) is
  begin
    if rst = '1' then
      count_reg <= (others => '0');
    elsif rising_edge(clk) then
      count_reg <= count_reg + 1;
    end if;
  end process count_proc;
end architecture rtl;

package math_pkg is
  function saturate(v : integer; lim : integer) return integer;
  procedure clamp(signal v : inout integer; lim : integer);
end package math_pkg;

package body math_pkg is
  function saturate(v : integer; lim : integer) return integer is
  begin
    if v > lim then
      return lim;
    else
      return v;
    end if;
  end function saturate;

  procedure clamp(signal v : inout integer; lim : integer) is
  begin
    if v > lim then
      v <= lim;
    end if;
  end procedure clamp;
end package body math_pkg;
