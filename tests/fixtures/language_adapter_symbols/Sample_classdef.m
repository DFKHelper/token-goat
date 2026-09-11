% FORMAT-DERIVED: https://www.mathworks.com/help/matlab/ref/classdef.html (classdef with properties, methods and events blocks), https://www.mathworks.com/help/matlab/ref/function.html (function syntax), https://www.mathworks.com/help/matlab/ref/end.html (end as an index), https://www.mathworks.com/help/matlab/matlab_prog/comments.html (% and %{ %} comments, ... continuation)
classdef Motor < handle
    properties
        SpeedRange = [0 180]
    end
    properties (SetAccess = private)
        Speed = 0
    end
    events
        SpeedChanged
    end
    methods
        function obj = Motor(range)
            obj.SpeedRange = range;
        end
        function startMotor(obj,speed)
            if speed < obj.SpeedRange(end)
                obj.Speed = speed;
            else
                disp('function notAFunction(x)')
            end
            notify(obj,'SpeedChanged')
        end
        %{
        function commentedOut(obj)
        end
        %}
        function stopMotor(obj)
            obj.Speed = ...
                0;
        end
    end
end
