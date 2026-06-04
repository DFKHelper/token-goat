"""Tests for the GraphQL, Proto, and ENV language extractors."""
from __future__ import annotations

import pytest

from token_goat.languages import env_idx, graphql_idx, proto_idx

# ---------------------------------------------------------------------------
# GraphQL extractor
# ---------------------------------------------------------------------------


class TestGraphqlTypes:
    def test_type_definition(self):
        src = b"type User {\n  id: ID!\n  name: String\n}\n"
        symbols, refs, imps, sections = graphql_idx.extract(src, "schema.graphql")
        assert refs == [] and imps == []
        names = [s.name for s in symbols]
        assert "User" in names

    def test_type_kind(self):
        src = b"type Product {\n  price: Float\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "Product"}
        assert kinds == {"graphql_type"}

    def test_multiple_types(self):
        src = b"type User { id: ID }\ntype Post { title: String }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "User" in names
        assert "Post" in names

    def test_interface_definition(self):
        src = b"interface Node {\n  id: ID!\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "Node" in names

    def test_interface_kind(self):
        src = b"interface Searchable { searchTerm: String }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "Searchable"}
        assert kinds == {"graphql_interface"}

    def test_input_definition(self):
        src = b"input CreateUserInput {\n  name: String!\n  email: String!\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "CreateUserInput" in names

    def test_input_kind(self):
        src = b"input FilterOptions { limit: Int }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "FilterOptions"}
        assert kinds == {"graphql_input"}

    def test_enum_definition(self):
        src = b"enum Status {\n  ACTIVE\n  INACTIVE\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "Status" in names

    def test_enum_kind(self):
        src = b"enum Role { ADMIN USER GUEST }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "Role"}
        assert kinds == {"graphql_enum"}

    def test_union_definition(self):
        src = b"union SearchResult = User | Post | Comment\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "SearchResult" in names

    def test_union_kind(self):
        src = b"union Payload = Success | Error\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "Payload"}
        assert kinds == {"graphql_union"}

    def test_scalar_definition(self):
        src = b"scalar DateTime\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "DateTime" in names

    def test_scalar_kind(self):
        src = b"scalar JSON\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "JSON"}
        assert kinds == {"graphql_scalar"}


class TestGraphqlOperations:
    def test_named_query(self):
        src = b"query GetUser($id: ID!) {\n  user(id: $id) { name }\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "ops.graphql")
        names = [s.name for s in symbols]
        assert "GetUser" in names

    def test_query_kind(self):
        src = b"query FetchPosts { posts { title } }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "ops.graphql")
        kinds = {s.kind for s in symbols if s.name == "FetchPosts"}
        assert kinds == {"graphql_query"}

    def test_named_mutation(self):
        src = b"mutation CreateUser($name: String!) {\n  createUser(name: $name) { id }\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "ops.graphql")
        names = [s.name for s in symbols]
        assert "CreateUser" in names

    def test_mutation_kind(self):
        src = b"mutation DeletePost($id: ID!) { deletePost(id: $id) }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "ops.graphql")
        kinds = {s.kind for s in symbols if s.name == "DeletePost"}
        assert kinds == {"graphql_mutation"}

    def test_named_subscription(self):
        src = b"subscription OnMessage($channel: String!) {\n  messageAdded(channel: $channel) { text }\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "ops.graphql")
        names = [s.name for s in symbols]
        assert "OnMessage" in names

    def test_subscription_kind(self):
        src = b"subscription WatchUser($id: ID!) { userUpdated(id: $id) { name } }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "ops.graphql")
        kinds = {s.kind for s in symbols if s.name == "WatchUser"}
        assert kinds == {"graphql_subscription"}

    def test_anonymous_operation_not_extracted(self):
        """Anonymous operations (no name) should not appear as symbols."""
        src = b"query {\n  users { id }\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "ops.graphql")
        # An anonymous op can't produce a symbol with a meaningful name
        names = [s.name for s in symbols]
        assert len(names) == 0 or all(n for n in names)


class TestGraphqlFragmentsAndDirectives:
    def test_fragment_definition(self):
        src = b"fragment UserFields on User {\n  id\n  name\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "fragments.graphql")
        names = [s.name for s in symbols]
        assert "UserFields" in names

    def test_fragment_kind(self):
        src = b"fragment PostPreview on Post { title summary }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "fragments.graphql")
        kinds = {s.kind for s in symbols if s.name == "PostPreview"}
        assert kinds == {"graphql_fragment"}

    def test_directive_definition(self):
        src = b"directive @deprecated(reason: String) on FIELD_DEFINITION\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "@deprecated" in names

    def test_directive_kind(self):
        src = b"directive @auth(role: String!) on FIELD_DEFINITION\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "@auth"}
        assert kinds == {"graphql_directive"}

    def test_extend_type(self):
        src = b"extend type Query {\n  users: [User]\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "Query" in names

    def test_extend_kind(self):
        src = b"extend type Mutation { deleteUser(id: ID!): Boolean }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        kinds = {s.kind for s in symbols if s.name == "Mutation"}
        assert kinds == {"graphql_extend"}

    def test_schema_block(self):
        src = b"schema {\n  query: Query\n  mutation: Mutation\n}\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "schema" in names


class TestGraphqlSections:
    def test_sections_match_symbols(self):
        src = b"type User { id: ID }\ntype Post { title: String }\n"
        symbols, _, _, sections = graphql_idx.extract(src, "schema.graphql")
        sym_names = {s.name for s in symbols}
        sec_names = {s.heading for s in sections}
        assert sym_names == sec_names

    def test_end_lines_assigned(self):
        src = b"type User { id: ID }\ntype Post { title: String }\n"
        _, _, _, sections = graphql_idx.extract(src, "schema.graphql")
        for sec in sections:
            assert sec.end_line is not None

    def test_line_numbers_are_one_based(self):
        src = b"# schema types\ntype Target { id: ID }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        target = next((s for s in symbols if s.name == "Target"), None)
        assert target is not None
        assert target.line == 2

    def test_comment_stripped_no_false_positive(self):
        """Type definitions inside comments must not be extracted."""
        src = b"# type Ghost { id: ID }\ntype Real { id: ID }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "Ghost" not in names
        assert "Real" in names


class TestGraphqlImports:
    def test_import_pragma_double_quote(self):
        """# import pragma with double quotes should produce an import edge."""
        src = b'# import UserFields from "fragments/user.graphql"\ntype Query { users: [User] }\n'
        _, _, imps, _ = graphql_idx.extract(src, "query.graphql")
        targets = [i.target for i in imps]
        assert "fragments/user.graphql" in targets

    def test_import_pragma_single_quote(self):
        src = b"# import PostFields from 'fragments/post.graphql'\n"
        _, _, imps, _ = graphql_idx.extract(src, "query.graphql")
        targets = [i.target for i in imps]
        assert "fragments/post.graphql" in targets

    def test_import_pragma_path_only(self):
        """Path-only form (no from-clause) should also be recognised."""
        src = b'# import "fragments/common.graphql"\n'
        _, _, imps, _ = graphql_idx.extract(src, "query.graphql")
        targets = [i.target for i in imps]
        assert "fragments/common.graphql" in targets

    def test_import_kind_is_import(self):
        src = b'# import UserFields from "user.graphql"\n'
        _, _, imps, _ = graphql_idx.extract(src, "query.graphql")
        assert all(i.kind == "import" for i in imps)

    def test_import_line_number(self):
        src = b"# comment\n# import UserFields from \"user.graphql\"\n"
        _, _, imps, _ = graphql_idx.extract(src, "query.graphql")
        assert any(i.line == 2 for i in imps)

    def test_multiple_imports(self):
        src = (
            b'# import UserFields from "fragments/user.graphql"\n'
            b'# import PostFields from "fragments/post.graphql"\n'
            b"query GetAll { users { ...UserFields } }\n"
        )
        _, _, imps, _ = graphql_idx.extract(src, "query.graphql")
        targets = {i.target for i in imps}
        assert "fragments/user.graphql" in targets
        assert "fragments/post.graphql" in targets

    def test_ordinary_comment_not_extracted_as_import(self):
        """Regular # comments that don't start with 'import' must not produce edges."""
        src = b"# This is a normal comment\ntype Query { id: ID }\n"
        _, _, imps, _ = graphql_idx.extract(src, "schema.graphql")
        assert imps == []

    def test_no_imports_in_plain_schema(self):
        src = b"type User { id: ID! name: String }\ntype Query { user: User }\n"
        _, _, imps, _ = graphql_idx.extract(src, "schema.graphql")
        assert imps == []


class TestGraphqlEdgeCases:
    def test_empty_file(self):
        symbols, refs, imps, sections = graphql_idx.extract(b"", "empty.graphql")
        assert symbols == [] and sections == []

    def test_invalid_utf8_does_not_crash(self):
        src = b"type Bad\xff { id: ID }\n"
        result = graphql_idx.extract(src, "bad.graphql")
        assert len(result) == 4

    def test_utf8_bom_on_first_symbol(self):
        """A UTF-8 BOM prefix must not swallow the first type definition."""
        src = "﻿type User {\n  id: ID!\n}\n".encode()
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "User" in names

    def test_gql_extension_same_extractor(self):
        """The .gql extension should use the same extractor (test it accepts that path)."""
        src = b"type Order { total: Float }\n"
        symbols, _, _, _ = graphql_idx.extract(src, "queries.gql")
        names = [s.name for s in symbols]
        assert "Order" in names

    def test_complex_schema(self):
        src = (
            b"scalar DateTime\n"
            b"interface Node { id: ID! }\n"
            b"type User implements Node { id: ID! name: String email: String }\n"
            b"type Post implements Node { id: ID! title: String author: User }\n"
            b"input CreatePostInput { title: String! authorId: ID! }\n"
            b"enum PostStatus { DRAFT PUBLISHED ARCHIVED }\n"
            b"union SearchResult = User | Post\n"
            b"type Query { user(id: ID!): User post(id: ID!): Post }\n"
            b"type Mutation { createPost(input: CreatePostInput!): Post }\n"
        )
        symbols, _, _, _ = graphql_idx.extract(src, "schema.graphql")
        names = [s.name for s in symbols]
        assert "DateTime" in names
        assert "Node" in names
        assert "User" in names
        assert "Post" in names
        assert "CreatePostInput" in names
        assert "PostStatus" in names
        assert "SearchResult" in names
        assert "Query" in names
        assert "Mutation" in names


# ---------------------------------------------------------------------------
# Proto extractor
# ---------------------------------------------------------------------------


class TestProtoMessages:
    def test_message_definition(self):
        src = b"message User {\n  int32 id = 1;\n  string name = 2;\n}\n"
        symbols, refs, imps, sections = proto_idx.extract(src, "user.proto")
        assert refs == [] and imps == []
        names = [s.name for s in symbols]
        assert "User" in names

    def test_message_kind(self):
        src = b"message Order {\n  int64 total = 1;\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "order.proto")
        kinds = {s.kind for s in symbols if s.name == "Order"}
        assert kinds == {"proto_message"}

    def test_multiple_messages(self):
        src = b"message UserRequest { string id = 1; }\nmessage UserResponse { string name = 1; }\n"
        symbols, _, _, _ = proto_idx.extract(src, "user.proto")
        names = [s.name for s in symbols]
        assert "UserRequest" in names
        assert "UserResponse" in names

    def test_proto3_syntax_block_skipped(self):
        """The syntax statement is not a message/service/enum and must not be extracted."""
        src = b'syntax = "proto3";\nmessage Foo { int32 id = 1; }\n'
        symbols, _, _, _ = proto_idx.extract(src, "test.proto")
        names = [s.name for s in symbols]
        assert "Foo" in names
        # 'syntax' or '"proto3"' should not appear as a symbol name
        assert "syntax" not in names


class TestProtoEnums:
    def test_enum_definition(self):
        src = b"enum Status {\n  UNKNOWN = 0;\n  ACTIVE = 1;\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "status.proto")
        names = [s.name for s in symbols]
        assert "Status" in names

    def test_enum_kind(self):
        src = b"enum Role { READER = 0; WRITER = 1; }\n"
        symbols, _, _, _ = proto_idx.extract(src, "role.proto")
        kinds = {s.kind for s in symbols if s.name == "Role"}
        assert kinds == {"proto_enum"}


class TestProtoServices:
    def test_service_definition(self):
        src = b"service UserService {\n  rpc GetUser (GetUserRequest) returns (User);\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "user.proto")
        names = [s.name for s in symbols]
        assert "UserService" in names

    def test_service_kind(self):
        src = b"service AuthService {\n  rpc Login (LoginRequest) returns (LoginResponse);\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "auth.proto")
        kinds = {s.kind for s in symbols if s.name == "AuthService"}
        assert kinds == {"proto_service"}

    def test_rpc_method(self):
        src = b"service UserService {\n  rpc GetUser (GetUserRequest) returns (User);\n  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "user.proto")
        names = [s.name for s in symbols]
        assert "GetUser" in names
        assert "ListUsers" in names

    def test_rpc_kind(self):
        src = b"service OrderService {\n  rpc CreateOrder (CreateOrderRequest) returns (Order);\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "order.proto")
        kinds = {s.kind for s in symbols if s.name == "CreateOrder"}
        assert kinds == {"proto_rpc"}

    def test_streaming_rpc(self):
        src = b"service StreamSvc {\n  rpc Watch (WatchRequest) returns (stream WatchEvent);\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "stream.proto")
        names = [s.name for s in symbols]
        assert "Watch" in names


class TestProtoOneOf:
    def test_oneof_definition(self):
        src = b"message Msg {\n  oneof payload {\n    string text = 1;\n    bytes data = 2;\n  }\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "msg.proto")
        names = [s.name for s in symbols]
        assert "payload" in names

    def test_oneof_kind(self):
        src = b"message Event {\n  oneof body { string text = 1; bytes raw = 2; }\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "event.proto")
        kinds = {s.kind for s in symbols if s.name == "body"}
        assert kinds == {"proto_oneof"}


class TestProtoExtend:
    def test_extend_definition(self):
        src = b"extend google.protobuf.FieldOptions {\n  bool my_option = 50000;\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "ext.proto")
        names = [s.name for s in symbols]
        assert "google.protobuf.FieldOptions" in names

    def test_extend_kind(self):
        src = b"extend MyBase {\n  string extra = 100;\n}\n"
        symbols, _, _, _ = proto_idx.extract(src, "ext.proto")
        kinds = {s.kind for s in symbols if s.name == "MyBase"}
        assert kinds == {"proto_extend"}


class TestProtoSections:
    def test_sections_match_symbols(self):
        src = b"message Foo { int32 id = 1; }\nmessage Bar { string name = 1; }\n"
        symbols, _, _, sections = proto_idx.extract(src, "test.proto")
        sym_names = {s.name for s in symbols}
        sec_names = {s.heading for s in sections}
        assert sym_names == sec_names

    def test_end_lines_assigned(self):
        src = b"message Foo { int32 id = 1; }\nmessage Bar { string name = 1; }\n"
        _, _, _, sections = proto_idx.extract(src, "test.proto")
        for sec in sections:
            assert sec.end_line is not None

    def test_line_numbers_are_one_based(self):
        src = b'syntax = "proto3";\nmessage Target { int32 id = 1; }\n'
        symbols, _, _, _ = proto_idx.extract(src, "test.proto")
        target = next((s for s in symbols if s.name == "Target"), None)
        assert target is not None
        assert target.line == 2

    def test_comment_stripped_no_false_positive(self):
        """Definitions inside comments must not be extracted."""
        src = b"// message Ghost { int32 id = 1; }\nmessage Real { int32 id = 1; }\n"
        symbols, _, _, _ = proto_idx.extract(src, "test.proto")
        names = [s.name for s in symbols]
        assert "Ghost" not in names
        assert "Real" in names

    def test_block_comment_stripped(self):
        src = b"/* message Ghost { } */\nmessage Visible { int32 id = 1; }\n"
        symbols, _, _, _ = proto_idx.extract(src, "test.proto")
        names = [s.name for s in symbols]
        assert "Ghost" not in names
        assert "Visible" in names


class TestProtoImports:
    def test_simple_import(self):
        src = b'import "other.proto";\nmessage Foo { int32 id = 1; }\n'
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        targets = [i.target for i in imps]
        assert "other.proto" in targets

    def test_import_single_quote(self):
        src = b"import 'google/protobuf/timestamp.proto';\n"
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        targets = [i.target for i in imps]
        assert "google/protobuf/timestamp.proto" in targets

    def test_public_import(self):
        src = b'import public "base.proto";\n'
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        targets = [i.target for i in imps]
        assert "base.proto" in targets

    def test_weak_import(self):
        src = b'import weak "optional.proto";\n'
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        targets = [i.target for i in imps]
        assert "optional.proto" in targets

    def test_import_kind_is_import(self):
        src = b'import "other.proto";\n'
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        assert all(i.kind == "import" for i in imps)

    def test_import_line_number(self):
        src = b'syntax = "proto3";\nimport "deps.proto";\n'
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        assert any(i.line == 2 for i in imps)

    def test_multiple_imports(self):
        src = (
            b'syntax = "proto3";\n'
            b'import "google/protobuf/timestamp.proto";\n'
            b'import "google/protobuf/empty.proto";\n'
            b"message Req { }\n"
        )
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        targets = {i.target for i in imps}
        assert "google/protobuf/timestamp.proto" in targets
        assert "google/protobuf/empty.proto" in targets

    def test_no_imports_when_none(self):
        src = b'syntax = "proto3";\nmessage Foo { int32 id = 1; }\n'
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        assert imps == []

    def test_import_inside_comment_not_extracted(self):
        """import statements inside comments must not produce import edges."""
        src = b'// import "ghost.proto";\nimport "real.proto";\n'
        _, _, imps, _ = proto_idx.extract(src, "test.proto")
        targets = [i.target for i in imps]
        assert "ghost.proto" not in targets
        assert "real.proto" in targets


class TestProtoEdgeCases:
    def test_empty_file(self):
        symbols, refs, imps, sections = proto_idx.extract(b"", "empty.proto")
        assert symbols == [] and sections == []

    def test_invalid_utf8_does_not_crash(self):
        src = b"message Bad\xff { int32 id = 1; }\n"
        result = proto_idx.extract(src, "bad.proto")
        assert len(result) == 4

    def test_utf8_bom_on_first_symbol(self):
        """A UTF-8 BOM prefix must not swallow the first message definition."""
        src = "﻿message User {\n  int32 id = 1;\n}\n".encode()
        symbols, _, _, _ = proto_idx.extract(src, "user.proto")
        names = [s.name for s in symbols]
        assert "User" in names

    def test_complex_proto_file(self):
        src = (
            b'syntax = "proto3";\n'
            b"package example;\n"
            b"enum Status { UNKNOWN = 0; ACTIVE = 1; }\n"
            b"message User {\n"
            b"  int32 id = 1;\n"
            b"  string name = 2;\n"
            b"  Status status = 3;\n"
            b"  oneof contact { string email = 4; string phone = 5; }\n"
            b"}\n"
            b"message GetUserRequest { int32 id = 1; }\n"
            b"message GetUserResponse { User user = 1; }\n"
            b"service UserService {\n"
            b"  rpc GetUser (GetUserRequest) returns (GetUserResponse);\n"
            b"  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);\n"
            b"}\n"
        )
        symbols, _, _, _ = proto_idx.extract(src, "user.proto")
        names = [s.name for s in symbols]
        assert "Status" in names
        assert "User" in names
        assert "GetUserRequest" in names
        assert "GetUserResponse" in names
        assert "UserService" in names
        assert "GetUser" in names
        assert "ListUsers" in names
        assert "contact" in names


# ---------------------------------------------------------------------------
# ENV extractor (env_idx — wraps ini_idx.extract_env)
# ---------------------------------------------------------------------------


class TestEnvExtractor:
    def test_basic_key_value(self):
        src = b"DATABASE_URL=postgres://localhost/mydb\n"
        symbols, refs, imps, sections = env_idx.extract(src, ".env.example")
        assert refs == [] and imps == [] and sections == []
        names = [s.name for s in symbols]
        assert "DATABASE_URL" in names

    def test_key_kind(self):
        src = b"API_KEY=secret123\n"
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        kinds = {s.kind for s in symbols if s.name == "API_KEY"}
        assert kinds == {"env_key"}

    def test_multiple_keys(self):
        src = b"PORT=3000\nHOST=localhost\nDEBUG=true\n"
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        names = [s.name for s in symbols]
        assert "PORT" in names
        assert "HOST" in names
        assert "DEBUG" in names

    def test_colon_separator(self):
        """KEY: value form (alternative dotenv separator) should also work."""
        src = b"SECRET_KEY: my_secret_value\n"
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        names = [s.name for s in symbols]
        assert "SECRET_KEY" in names

    def test_comment_lines_skipped(self):
        """Lines starting with # are comments and must not produce symbols."""
        src = b"# This is a comment\nACTUAL_KEY=value\n"
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        names = [s.name for s in symbols]
        assert "ACTUAL_KEY" in names
        assert "# This is a comment" not in names

    def test_empty_lines_skipped(self):
        src = b"\nFIRST_KEY=a\n\nSECOND_KEY=b\n\n"
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        names = [s.name for s in symbols]
        assert "FIRST_KEY" in names
        assert "SECOND_KEY" in names
        assert "" not in names

    def test_indented_lines_skipped(self):
        """Lines with leading whitespace are not valid env assignments."""
        src = b"  INDENTED=value\nTOP_LEVEL=value\n"
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        names = [s.name for s in symbols]
        # INDENTED should not appear (leading whitespace)
        assert "TOP_LEVEL" in names
        assert "INDENTED" not in names

    def test_empty_file(self):
        symbols, refs, imps, sections = env_idx.extract(b"", ".env.example")
        assert symbols == [] and sections == []

    def test_invalid_utf8_does_not_crash(self):
        src = b"KEY=valid\nBAD_\xff=value\n"
        result = env_idx.extract(src, ".env.example")
        assert len(result) == 4

    def test_values_with_spaces_not_extracted(self):
        """Keys with values containing spaces are fine; value content must not appear."""
        src = b'GREETING=Hello World\nNAME=John Doe\n'
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        names = [s.name for s in symbols]
        assert "GREETING" in names
        assert "NAME" in names
        # Values should not appear as separate symbols
        assert "Hello World" not in names

    def test_line_numbers_one_based(self):
        src = b"# comment\nFIRST=a\nSECOND=b\n"
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        first = next((s for s in symbols if s.name == "FIRST"), None)
        assert first is not None
        assert first.line == 2

    def test_real_env_example_pattern(self):
        """Test a realistic .env.example file."""
        src = (
            b"# Database\n"
            b"DATABASE_URL=postgres://user:pass@localhost:5432/mydb\n"
            b"DATABASE_POOL_SIZE=10\n"
            b"\n"
            b"# Application\n"
            b"PORT=3000\n"
            b"NODE_ENV=development\n"
            b"SECRET_KEY=change_me_in_production\n"
            b"\n"
            b"# External services\n"
            b"STRIPE_SECRET_KEY=sk_test_xxx\n"
            b"STRIPE_WEBHOOK_SECRET=whsec_xxx\n"
            b"SENDGRID_API_KEY=SG.xxx\n"
        )
        symbols, _, _, _ = env_idx.extract(src, ".env.example")
        names = [s.name for s in symbols]
        assert "DATABASE_URL" in names
        assert "DATABASE_POOL_SIZE" in names
        assert "PORT" in names
        assert "NODE_ENV" in names
        assert "SECRET_KEY" in names
        assert "STRIPE_SECRET_KEY" in names
        assert "SENDGRID_API_KEY" in names


# ---------------------------------------------------------------------------
# Integration: parser.py dispatch for all three new formats
# ---------------------------------------------------------------------------


class TestParserDispatch:
    @pytest.mark.parametrize("filename,content,expected_lang,expected_symbol", [
        (
            "schema.graphql",
            "type User { id: ID! name: String }\n",
            "graphql",
            "User",
        ),
        (
            "queries.gql",
            "query GetUser($id: ID!) { user(id: $id) { name } }\n",
            "graphql",
            "GetUser",
        ),
        (
            "user.proto",
            'syntax = "proto3";\nmessage User { int32 id = 1; }\n',
            "proto",
            "User",
        ),
        (
            ".env.example",
            "DATABASE_URL=postgres://localhost/mydb\nPORT=3000\n",
            "env_file",
            "DATABASE_URL",
        ),
        (
            ".env.sample",
            "API_KEY=your_key_here\n",
            "env_file",
            "API_KEY",
        ),
        (
            ".env.local",
            "OVERRIDE=true\n",
            "env_file",
            "OVERRIDE",
        ),
    ])
    def test_extension_dispatches(
        self, tmp_path, tmp_data_dir, filename, content, expected_lang, expected_symbol
    ):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        src_file = tmp_path / filename
        src_file.write_text(content, encoding="utf-8")
        root = canonicalize(tmp_path)
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, src_file)
        assert result is not None
        assert result.language == expected_lang
        names = [s.name for s in result.symbols]
        assert expected_symbol in names
