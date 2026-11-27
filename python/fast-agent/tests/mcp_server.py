"""A stub MCP server over stdio for the bridge's tests: one tool that changes something."""

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

server = MCPServer("stub")


@server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False))
def ship(city: str) -> str:
    """Ship a parcel to a city."""
    return f"shipped to {city}"


if __name__ == "__main__":
    server.run("stdio")
