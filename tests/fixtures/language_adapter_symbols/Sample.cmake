# FORMAT-DERIVED: https://cmake.org/cmake/help/latest/manual/cmake-language.7.html (command invocations, line and bracket comments, quoted and bracket arguments), https://cmake.org/cmake/help/latest/command/function.html, https://cmake.org/cmake/help/latest/command/macro.html, https://cmake.org/cmake/help/latest/command/project.html, https://cmake.org/cmake/help/latest/command/add_library.html, https://cmake.org/cmake/help/latest/command/add_executable.html, https://cmake.org/cmake/help/latest/command/add_custom_target.html
cmake_minimum_required(VERSION 3.20)
project(Tutorial VERSION 1.0 LANGUAGES CXX)

include(CTest)
find_package(Threads REQUIRED)
add_subdirectory(MathFunctions)

#[[ A bracket comment:
function(not_a_function)
endfunction()
]]

function(add_tutorial_test name)
  add_test(NAME ${name} COMMAND Tutorial ${ARGN})
  message(STATUS "function(fake_in_string)")
endfunction()

MACRO(Print_Args)
  message([=[macro(fake_in_bracket)]=])
ENDMACRO()

add_library(MathFunctions STATIC mysqrt.cxx)
add_executable(Tutorial
  tutorial.cxx
)
add_custom_target(docs ALL
  COMMAND doxygen Doxyfile
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
)
add_library(${PROJECT_NAME}_extra INTERFACE)
