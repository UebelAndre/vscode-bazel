"""Helpers mirroring `rust/private/utils.bzl` in rules_rust."""

def dedent(doc_string):
    """Removes common leading whitespace from a docstring.

    Args:
        doc_string: The string to dedent.

    Returns:
        The dedented string.
    """
    lines = doc_string.splitlines()
    if not lines:
        return doc_string
    indent = None
    for line in lines:
        stripped = line.lstrip()
        if not stripped:
            continue
        current = len(line) - len(stripped)
        if indent == None or current < indent:
            indent = current
    if not indent:
        return doc_string
    return "\n".join([line[indent:] for line in lines])
