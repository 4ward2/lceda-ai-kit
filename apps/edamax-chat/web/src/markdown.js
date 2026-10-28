import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import DOMPurify from 'dompurify';
import 'highlight.js/styles/github-dark.css';

// Register only languages likely to appear in EDA/agent output to keep the
// bundle small (full highlight.js pulls in ~1MB of grammars).
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import cpp from 'highlight.js/lib/languages/cpp';
import verilog from 'highlight.js/lib/languages/verilog';
import plaintext from 'highlight.js/lib/languages/plaintext';

for (const [name, lang] of Object.entries({ javascript, python, json, bash, xml, cpp, verilog, plaintext })) {
  hljs.registerLanguage(name, lang);
}
hljs.registerAliases(['js', 'ts', 'typescript'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['c', 'c++'], { languageName: 'cpp' });
hljs.registerAliases(['v', 'sv', 'systemverilog'], { languageName: 'verilog' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : '';
    const html = language
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : md.utils.escapeHtml(code);
    const label = md.utils.escapeHtml(language || 'text');
    // The copy button reads the raw text back out of the <code> element.
    return `<div class="codeblock"><div class="cbBar"><span>${label}</span>` +
      `<button class="cbCopy" type="button">复制</button></div>` +
      `<pre class="hljs"><code>${html}</code></pre></div>`;
  }
});

// Open links in a new tab.
const defaultLinkOpen = md.renderer.rules.link_open ||
  ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, i, options, env, self);
};

export function renderMarkdown(text = '') {
  return DOMPurify.sanitize(md.render(text), {
    ADD_ATTR: ['target', 'rel']
  });
}
