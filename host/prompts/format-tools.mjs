function schemaParams(tool) {
  if (!tool.inputSchema) return '';
  const shape = tool.inputSchema._zod?.def?.shape;
  if (!shape) return '';
  const params = Object.entries(shape).map(([key, field]) => {
    const optional = field._zod?.def?.optional || field.isOptional?.() ? '?' : '';
    return `${key}${optional}`;
  });
  return params.join(', ');
}

export function formatTools(tools) {
  const lines = ['Available tools:', ''];
  for (const tool of tools) {
    const params = schemaParams(tool);
    const sig = `${tool.name}(${params})`;
    const rev = tool.reversible === false ? '[irreversible]' : '[reversible]';
    lines.push(`- ${sig} — ${tool.description} ${rev}`);
  }
  return lines.join('\n');
}
