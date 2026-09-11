# FORMAT-DERIVED: Perl documentation: https://perldoc.perl.org/perlmod (package declaration and package scope, __END__), https://perldoc.perl.org/perlsub (named subroutine definitions), https://perldoc.perl.org/perlpod (=head1, =over, =item, =back, =cut), https://perldoc.perl.org/perlop (the <<~ indented heredoc), https://perldoc.perl.org/Exporter (@ISA and @EXPORT).

=head1 NAME

Demo::Paths - split, join and tidy separator-delimited paths.

=head1 SYNOPSIS

    use Demo::Paths;

    my ($name, $dirs, $suffix) = split_path($fullname, @suffixlist);
    my $base = base_name($fullname);
    my $dir  = dir_name($fullname);

=head1 DESCRIPTION

A small package whose subroutines are separated by POD blocks, so that the
indexer has a real example of a body it must read past.

=cut

package Demo::Paths;

use strict;
use warnings;

require Exporter;

our @ISA    = qw(Exporter);
our @EXPORT = qw(split_path base_name dir_name normalize_sep set_separator);

our $SEPARATOR = '/';

=head1 FUNCTIONS

=over 4

=item C<split_path>

    my ($name, $dirs, $suffix) = split_path($path);
    my ($name, $dirs, $suffix) = split_path($path, @suffixes);

Divides a path into its directory part, its final component, and a trailing
suffix when one of the supplied patterns matches.

=cut

sub split_path {
    my ($path, @suffixes) = @_;
    return ('', '', '') unless defined $path;

    my $sep = quotemeta $SEPARATOR;
    my ($dirs, $name) = ('', $path);
    if ($path =~ m{^(.*$sep)([^$sep]*)$}) {
        ($dirs, $name) = ($1, $2);
    }

    my $suffix = '';
    for my $pattern (@suffixes) {
        next unless $name =~ /^(.*)($pattern)$/;
        ($name, $suffix) = ($1, $2);
        last;
    }

    return ($name, $dirs, $suffix);
}

=item C<base_name>

    my $base = base_name($path);

Returns the final component of a path, with any trailing separators removed
before the split.

=cut

sub base_name {
    my ($path, @suffixes) = @_;
    my ($name) = split_path(normalize_sep($path), @suffixes);
    return $name;
}

=item C<dir_name>

    my $dir = dir_name($path);

Returns everything before the final component, without its trailing separator.

=cut

sub dir_name {
    my ($path) = @_;
    my (undef, $dirs) = split_path($path);
    return $SEPARATOR if $dirs eq $SEPARATOR;

    my $tidy = normalize_sep($dirs);
    return '.' if $tidy eq '';
    return $tidy;
}

=item C<normalize_sep>

Strips trailing separators from a path, leaving a lone root alone.

=cut

sub normalize_sep {
    my ($path) = @_;
    return '' unless defined $path;

    my $sep = quotemeta $SEPARATOR;
    $path =~ s{(?<=.)$sep+$}{};
    return $path;
}

=item C<set_separator>

Chooses the separator the other routines split on.

=cut

sub set_separator {
    my ($sep) = @_;
    my $usage = <<~'EOT';
        set_separator expects a single character, for example:
            set_separator('/');
        EOT
    die $usage unless defined $sep && length($sep) == 1;

    $SEPARATOR = $sep;
    return $SEPARATOR;
}

=back

=cut

1;

__END__

=head1 AUTHOR

Written for token-goat's language-adapter tests.

=cut
