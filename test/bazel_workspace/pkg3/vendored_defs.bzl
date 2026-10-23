"""Public re-exports, mirroring `rust/defs.bzl` in rules_rust."""

load(
    ":vendored_rules.bzl",
    _vendored_binary = "vendored_binary",
    _vendored_common = "vendored_common",
    _vendored_library = "vendored_library",
    _vendored_test_suite = "vendored_test_suite",
)
load(":vendored_attrs.bzl", _VendoredInfo = "VendoredInfo")

vendored_binary = _vendored_binary
vendored_library = _vendored_library
vendored_test_suite = _vendored_test_suite
vendored_common = _vendored_common
VendoredInfo = _VendoredInfo
