{ FORMAT-DERIVED: https://www.freepascal.org/docs-html/ref/refse112.html (unit, interface, implementation), https://www.freepascal.org/docs-html/ref/refse35.html (class declarations, forward class), https://www.freepascal.org/docs-html/ref/refse92.html (procedures), https://www.freepascal.org/docs-html/ref/refse119.html (try ... except), https://www.freepascal.org/docs-html/ref/refse2.html (comments) }
unit Shapes;

interface

uses SysUtils, Classes;

type
  TColor = (clRed, clGreen, clBlue);
  TClassB = class;
  TClassA = class
  private
    FB: TClassB;
    FName: string;
  public
    constructor Create(const AName: string);
    destructor Destroy; override;
    procedure DoSomething(x: Integer); virtual;
    function Describe: string;
    property Name: string read FName write FName;
  end;
  TClassB = class(TClassA)
    procedure Extra; virtual; abstract;
  end;
  EShapeError = class(Exception);
  TPoint = record
    X, Y: Integer;
  end;

procedure DoSomething;

implementation

(* procedure NotReal; is inside a comment *)
// function AlsoNotReal: Integer;

constructor TClassA.Create(const AName: string);
begin
  inherited Create;
  FName := AName;
end;

destructor TClassA.Destroy;
begin
  FB.Free;
  inherited Destroy;
end;

procedure TClassA.DoSomething(x: Integer);
begin
  case x of
    0: WriteLn('procedure Fake;');
  else
    try
      WriteLn(x);
    except
      on E: Exception do
        WriteLn(E.Message);
    end;
  end;
end;

function TClassA.Describe: string;

  function Pad(const S: string): string;
  begin
    Result := ' ' + S;
  end;

begin
  Result := Pad(FName);
end;

procedure DoSomething;
begin
  WriteLn('Hello');
end;

end.
