import * as vscode from "vscode";

/**
 * Balises auto-fermantes connues
 */
const SELF_CLOSING = new Set([
  "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"
]);

/** util */
function escapeSnippet(s: string) {
  return s.replace(/\$/g, "\\$");
}

/**
 * Trouve le "mot" contigu (séquence sans espace ni < ni >) juste avant le curseur.
 * Retourne { token, startPos }. Si aucun token, token = "" et startPos = position.
 */
function getContiguousTokenBefore(document: vscode.TextDocument, position: vscode.Position): { token: string, startPos: vscode.Position } {
  const line = document.lineAt(position.line).text;
  let idx = position.character - 1;
  if (idx < 0) return { token: "", startPos: position };

  // marche arrière jusqu'à rencontrer un espace ou '<' ou '>' ou début de ligne
  while (idx >= 0) {
    const ch = line[idx];
    if (ch === ' ' || ch === '\t' || ch === '<' || ch === '>' || ch === '\n' || ch === '\r') break;
    idx--;
  }
  const start = idx + 1;
  const token = line.substring(start, position.character);
  return { token, startPos: new vscode.Position(position.line, start) };
}

/**
 * Parse un token comme :
 *  tag(.class)* (#id)? (\[attr(...)?\])*
 * et aussi accepte token ne contenant que [.class] ou [attr] (sans tag)
 * Retourne { tag?, classes[], id?, attrs[] , endsWith: '.'|'#'|'['|null }
 */
function parseToken(token: string) {
  const result = {
    tag: undefined as string | undefined,
    classes: [] as string[],
    id: undefined as string | undefined,
    attrs: [] as string[],
    endsWith: null as ('.' | '#' | '[' | null)
  };
  
  if (!token) return result;
  
  // detect trailing char (. # [) with nothing after
  const lastChar = token[token.length - 1];
  if (lastChar === '.' || lastChar === '#' || lastChar === '[') {
    result.endsWith = lastChar;
  }

  // We'll iterate from left to right
  let i = 0;
  // optional tag at beginning
  const tagMatch = token.slice(i).match(/^([A-Za-z][A-Za-z0-9-]*)/);
  if (tagMatch) {
    result.tag = tagMatch[1];
    i += tagMatch[1].length;
  }
  else {
    result.tag = "div";
  }

  // loop remaining
  while (i < token.length) {
    const ch = token[i];
    if (ch === '.') {
      // class (may be empty if endsWith '.')
      i++;
      let cls = "";
      while (i < token.length && /[A-Za-z0-9_-]/.test(token[i])) {
        cls += token[i++];
      }
      if (cls) result.classes.push(cls);
      else {
        // empty class => user just typed '.' -> handled via endsWith
      }
      continue;
    } else if (ch === '#') {
      i++;
      let id = "";
      while (i < token.length && /[A-Za-z0-9_-]/.test(token[i])) {
        id += token[i++];
      }
      if (id) result.id = id;
      else {
        // empty id -> user typed '#' only
      }
      continue;
    } else if (ch === '[') {
      // read until matching ']' or end of token
      i++;
      let inside = "";
      while (i < token.length && token[i] !== ']') {
        inside += token[i++];
      }
      // if token[i] == ']' consume it
      if (i < token.length && token[i] === ']') {
        i++; // consume ]
        result.attrs.push(inside);
      } else {
        // no closing ']' yet: we keep what's inside and note endsWith if appropriate
        result.attrs.push(inside);
        break;
      }
      continue;
    } else {
      // any other char (maybe malformed) - consume to avoid infinite loop
      i++;
    }
  }
  console.log(token,result)
  return result;
}

/**
 * Construire un snippet CompletionItem pour remplacer la plage 'replaceRange'
 * attrsArray: liste d'attributs exactes (ex: ['data-p="oi"', 'aria-label'])
 * classesArray: array of class strings
 * id: optional
 */
function makeCompletionForParsed(parsed: ReturnType<typeof parseToken>, replaceRange: vscode.Range | null) {
  const tag = (parsed.tag || "div");
  const isSelfClosing = SELF_CLOSING.has(tag.toLowerCase());

  // construire string d'attributs : className / id / attrs[]
  const parts: string[] = [];
  if (parsed.classes.length) {
    parts.push(`className="${escapeSnippet(parsed.classes.join(" "))}"`);
  }
  if (parsed.id) {
    parts.push(`id="${escapeSnippet(parsed.id)}"`);
  }
  // insérer les attrs tels qu'ils sont fournis
  for (const a of parsed.attrs) {
    if (a && a.trim().length) {
      parts.push(a);
    }
  }

  // si l'utilisateur vient juste de taper '.' ou '#' on veut proposer un placeholder
  if (parsed.endsWith === '.') {
    parts.push(`className="\${1}"`);
  } else if (parsed.endsWith === '#') {
    parts.push(`id="\${1}"`);
  } else if (parsed.endsWith === '[' && parsed.attrs.length && parsed.attrs[parsed.attrs.length - 1] === "") {
    // user typed '[' with nothing inside: add placeholder inside bracket
    // but we'll prefer proposing the attribute placed outside of brackets (JSX syntax expects attr not [attr])
    // for compatibility with your design, if endsWith '[' propose a placeholder attr token inserted as-is
    parts.push(`\${1:data-attr}`);
  }

  // assemble attrs snippet
  const attrsSnippet = parts.join(" ").trim();

  // build snippet string
  let insert: vscode.SnippetString;
  if (isSelfClosing) {
    if (attrsSnippet) insert = new vscode.SnippetString(`<${tag} ${attrsSnippet} />`);
    else insert = new vscode.SnippetString(`<${tag} />`);
  } else {
    if (attrsSnippet) insert = new vscode.SnippetString(`<${tag} ${attrsSnippet}>$0</${tag}>`);
    else insert = new vscode.SnippetString(`<${tag} \${1}>$0</${tag}>`);
  }

  const label = isSelfClosing ? `<${tag} />` : `<${tag}></${tag}>`;
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
  item.insertText = insert;
  if (replaceRange) item.range = replaceRange;
  item.detail = `JSX <${tag}> (generated from token)`;
  item.sortText = "000";
  return item;
}

/**
 * Activation
 */
export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = [
    { language: "javascript", scheme: "file" },
    { language: "javascriptreact", scheme: "file" },
    { language: "typescript", scheme: "file" },
    { language: "typescriptreact", scheme: "file" }
  ];
  
  const provider = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, ctx: vscode.CompletionContext) {
        // 1) récupérer le token contigu juste avant le curseur (sans espaces)
        const { token: rawToken, startPos } = getContiguousTokenBefore(document, position);
        
        // 2) si pas de token du tout, on peut early-return (ou proposer basiques)
        if (!rawToken) {
          // Optionnel: proposer une liste rapide de tags si l'utilisateur commence à taper lettres (déjà géré ailleurs)
          return undefined;
        }
        
        // 3) parser ce token entier
        const parsed = parseToken(rawToken);
        
        // 4) construire la Range de remplacement : du startPos jusqu'à position (on remplace le token entier)
        const replaceRange = new vscode.Range(startPos, position);
        
        const tag0 = parsed.tag || "div";
        const isSelf = SELF_CLOSING.has(tag0.toLowerCase());
        
        // 5) créer complétion principale (balise complète)
        const completions: vscode.CompletionItem[] = [];
        // completions.push(makeCompletionForParsed(parsed, replaceRange));

        // 6) Cas spécifiques : si token se termine par '.' => proposer className standalone
        if (parsed && parsed.tag) {
          const { tag, classes, id, attrs, endsWith } = parsed;

          let snippet = `<${tag}`;
          if (classes?.length) snippet += ` className="${classes.join(' ')}"`;
          if (rawToken.includes(".")) snippet +=  ` className=""`;
          if (id) snippet += ` id="${id}"`;
          if (rawToken.includes("#")) snippet +=  ` id=""`;
          if (attrs?.length)
            snippet += ' ' + attrs.join(' ');
          
          // Auto-closing tag si applicable
          const selfClosing = isSelf;
          if (selfClosing) {
            if (tag.toLocaleLowerCase() === "img") snippet += ` src=""`
            snippet += ' />';
          } else {
            snippet += `></${tag}>`;
          }
          console.log(snippet)
          const item = new vscode.CompletionItem(`<${tag}>`, vscode.CompletionItemKind.Snippet);
          item.insertText = new vscode.SnippetString(snippet);
          item.detail = `JSX autocompletion for <${tag}>`;
          item.documentation = `Génère automatiquement la balise <${tag}> complète avec ses attributs JSX.`;
          item.range = replaceRange;
          
          completions.push(item);
        }
       
        
       // 7) Sinon, comportement contextuel : on veut que les suggestions apparaissent aussi
        //    quand le curseur est juste après un ".", "#", ou "]".
        else {
            const firstChar = rawToken[0];
            console.log(firstChar)
            if ([".", "#","["].includes(firstChar)) {
                const { tag, classes, id, attrs, endsWith } = parsed;
                let snippet = `<div`;
                if (classes?.length)  snippet += ` className="${classes.join(' ')}"`;
                if (rawToken.includes(".")) snippet +=  ` className=""`;
                if (id) snippet += ` id="${id}"`;
                if (rawToken.includes("#")) snippet +=  ` id=""`;
                if (attrs?.length) snippet += ' ' + attrs.join(' ');
                
                // Auto-closing tag si applicable
                const selfClosing = isSelf;
                if (selfClosing) {
                    snippet += ' />';
                } else {
                    snippet += `></div>`;
                }

                const item = new vscode.CompletionItem(`<div>`, vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString(snippet);
                item.detail = `JSX autocompletion for <div>`;
                item.documentation = `Génère automatiquement la balise <div> complète avec ses attributs JSX.`;
                item.range = replaceRange;
                
                completions.push(item);
            }
        }
        
        
        return new vscode.CompletionList(completions, false);
      }
    },
    ".", "#", "[", "]", "<" // triggers
  );

  context.subscriptions.push(provider);
}

export function deactivate() {}

// je n'ai pas de suggestion alors voici mon log:
// div {tag: 'div', classes: Array(0), id: undefined, attrs: Array(0), endsWith: null}
// extensionHostProcess.js:207
// <div></div>
// extensionHostProcess.js:207
// div. {tag: 'div', classes: Array(0), id: undefined, attrs: Array(0), endsWith: '.'}
// extensionHostProcess.js:207
// <div className=""></div>

// pour "div" j'ai eu de suggestion mais pas pour "div." ni "div#" ...