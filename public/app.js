// ONLY updated portion for entity notes with links
const noteHtml = (identity.entity_notes || []).length
  ? `<ul>${identity.entity_notes.map(x => {
      // attempt to extract URL if present
      const urlMatch = x.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        return `<li>${escapeHtml(x.replace(urlMatch[0], ''))} 
                <a href="${urlMatch[0]}" target="_blank">Source</a></li>`;
      }
      return `<li>${escapeHtml(x)}</li>`;
    }).join('')}</ul>`
  : `<div>None identified</div>`;
