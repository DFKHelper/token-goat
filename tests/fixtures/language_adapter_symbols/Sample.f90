! FORMAT-DERIVED: https://fortran-lang.org/learn/quickstart/organising_code/ (module, contains, subroutine, function result), https://fortran-lang.org/learn/quickstart/derived_types/ (type ... end type with type-bound procedures), https://www.ibm.com/docs/en/xl-fortran-aix/16.1.0?topic=attributes-abstract-interfacefortran-2003 (abstract interface), https://www.ibm.com/docs/en/xl-fortran-aix/16.1.0?topic=formats-free-source-form (! comments, & continuation)
module my_mod
  implicit none

  private  ! All entities are now module-private by default
  public public_var, print_matrix  ! Explicitly export public entities

  real, parameter :: public_var = 2
  integer :: private_var

  type :: t_pair
    integer :: i
    real :: x
  contains
    procedure :: show => show_pair
  end type t_pair

  abstract interface
    real function proc(x)
      real, intent(in) :: x
    end function proc
  end interface

contains

  ! Print matrix A to screen
  subroutine print_matrix(A)
    real, intent(in) :: A(:,:)  ! An assumed-shape dummy argument

    integer :: i

    do i = 1, size(A,1)
      print *, A(i,:)
    end do

  end subroutine print_matrix

  function vector_norm(vec) result(norm)
    real, intent(in) :: vec(:)
    real :: norm

    norm = sqrt(sum(vec**2))

  end function vector_norm

  subroutine show_pair(self)
    class(t_pair), intent(in) :: self
    if (self%i > 0) then
      print *, 'subroutine fake(x)', &
               self%x
    end if
  end subroutine show_pair

end module my_mod

program use_mod
  use my_mod
  implicit none
  real :: mat(10, 10)
  mat(:,:) = public_var
  call print_matrix(mat)
end program use_mod
