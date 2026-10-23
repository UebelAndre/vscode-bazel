load(":defs.bzl", "my_macro", "my_test")
load(":vendored_cc.bzl", "vendored_cc_test")
load(":vendored_defs.bzl", "vendored_binary")

my_macro(
    name = "data",
    srcs = ["data.txt"],
)

my_test(name = "custom_test")

vendored_binary(
    name = "vendored",
    srcs = ["data.txt"],
)

vendored_cc_test(
    name = "cc_vendored_test",
    srcs = ["data.txt"],
)
