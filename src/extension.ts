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
 * Trouve le "mot" contigu autour du curseur, en le découpant selon les séparateurs usuels (espace, <, >, etc.).
 * 
 * - `token` : la partie immédiatement **avant** le curseur (sans séparateur)
 * - `postToken` : la partie immédiatement **après** le curseur (jusqu'au prochain séparateur)
 * - `startPos` : position dans le document où commence `token` (utile pour la Range de remplacement)
 * 
 * Par exemple, si la ligne est :
 * 
 * ```tsx
 * <MyComp.cla^ssName='foo'>
 * ```
 * (le curseur est entre le `a` et le `s`)
 * 
 * Alors cette fonction retournera :
 * - token: `"MyComp.cla"`
 * - postToken: `"ssName='foo'""`
 * - startPos: position du `M`
 * 
 * @param document Le document VSCode dans lequel on travaille
 * @param position La position actuelle du curseur
 * @returns Un objet contenant `token`, `startPos` et `postToken`
 */
function getContiguousTokenBefore(document: vscode.TextDocument, position: vscode.Position): { token: string, startPos: vscode.Position, postToken: string } {
  const line = document.lineAt(position.line).text;
  let backIdx = position.character - 1;
  let forwardIdx = position.character;
  
  if (backIdx < 0) return { token: "", startPos: position, postToken: "" };

  // Reculer pour trouver le début du token
  while (backIdx >= 0) {
    const ch = line[backIdx];
    if (ch === ' ' || ch === '\t' || ch === '<' || ch === '>' || ch === '\n' || ch === '\r') break;
    backIdx--;
  }
  let start = backIdx + 1;
  
  // Avancer pour trouver la fin du token
  while (forwardIdx < line.length) {
    const ch = line[forwardIdx];
    if (ch === ' ' || ch === '\t' || ch === '<' || ch === '>' || ch === '\n' || ch === '\r') break;
    forwardIdx++;
  }
  
   // Sélection brute
  let tokenStart = line.substring(start, position.character);
  let tokenEnd = line.substring(position.character, forwardIdx);

//   let firstChar = effemtoken[effemtoken.length-1];
//   let lastChar = effempostToken[effempostToken.length-1];
  
  // Nettoyage des caractères non pertinents en fin/début
  while (
    tokenStart.length > 0 &&
    !/[.#\[A-Za-z0-9_-]/.test(tokenStart[0])
  ) {
    start++;
    tokenStart = line.substring(start, position.character);
  }

  while (
    tokenEnd.length > 0 &&
    !/[.#\]A-Za-z0-9_-]/.test(tokenEnd[tokenEnd.length - 1])
  ) {
    forwardIdx--;
    tokenEnd = line.substring(position.character, forwardIdx);
  }
  
  
  const token = line.substring(start, position.character); // avant curseur
  const postToken = line.substring(position.character, forwardIdx); // après curseur

  return {
    token,
    startPos: new vscode.Position(position.line, start),
    postToken
  };
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
  
  // We'll iterate from left to right
  let i = 0;
  // optional tag at beginning
  const tagMatch = token.slice(i).match(/^([A-Za-z][A-Za-z0-9_-]*)/);
  if (tagMatch) {
    result.tag = tagMatch[1];
    i += tagMatch[1].length;
  }
  
  if (token.length >= 1) {
    const lastChar = token[token.length - 1];

    
    if ( token.length >= i ) {
        if ( !/[.#\[A-Za-z0-9_-]/.test(token[i]) ){
            return {
                tag: undefined as string | undefined,
                classes: [] as string[],
                id: undefined as string | undefined,
                attrs: [] as string[],
                endsWith: null as ('.' | '#' | '[' | null)
            };
        }
    }
    // if ( token.length >= i + 1) {
    //     if ( !/[.#\[A-Za-z0-9_-]/.test(token[i+1]) ){
    //         return {
    //             tag: undefined as string | undefined,
    //             classes: [] as string[],
    //             id: undefined as string | undefined,
    //             attrs: [] as string[],
    //             endsWith: null as ('.' | '#' | '[' | null)
    //         };
    //     }
    // }

    if ( !/[.#\]A-Za-z0-9_-]/.test(lastChar)){
        return {
            tag: undefined as string | undefined,
            classes: [] as string[],
            id: undefined as string | undefined,
            attrs: [] as string[],
            endsWith: null as ('.' | '#' | '[' | null)
        };
    }

    // detect trailing char (. # [) with nothing after
    if (lastChar === '.' || lastChar === '#' || lastChar === '[') {
      result.endsWith = lastChar;
    }
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
//   console.log(result);
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
        provideCompletionItems(
            document: vscode.TextDocument,
            position: vscode.Position,
            token: vscode.CancellationToken,
            ctx: vscode.CompletionContext
            ) {
            const { token: rawToken, startPos, postToken } = getContiguousTokenBefore(document, position);
            
            // if (!rawToken) {
            //     return undefined;
            // }
            if (!rawToken && ctx.triggerKind !== vscode.CompletionTriggerKind.TriggerForIncompleteCompletions) {
                return undefined;
            }
            
            const completions: vscode.CompletionItem[] = [];
            
            const finalToken = rawToken+postToken;
            
            // const replaceRange = new vscode.Range(startPos, position);
            const replaceRange = new vscode.Range(startPos, new vscode.Position(position.line, position.character + postToken.length));
            
            // const escapedToken = escapeSnippet(finalToken);
            
            if (/^jsx/.test(finalToken)) {
                const hintItem = new vscode.CompletionItem(
                    "💡 jsxbuildXcomponent__tag pour créer un composant React",
                    vscode.CompletionItemKind.Snippet
                );
                hintItem.insertText = "jsxbuildXcomponent__tag"; // Ne remplace rien
                hintItem.detail = "Ex: jsxbuildCard__section → function Card() { return <section> }";
                hintItem.documentation = new vscode.MarkdownString(
                    `👉 Pour générer un **composant React** avec props auto-gérés, tape \`jsxbuildNom__balise\`.\n\n**Exemples** :\n- \`jsxbuildCard__section\`\n- \`jsxbuildHeader__header\``
                );
                hintItem.range = replaceRange;
                hintItem.sortText = "001"; // Position basse

                completions.push(hintItem);
                }

            // ✨ Snippet spécial pour jsxbuildX__tag
            const jsxBuildMatch = finalToken.match(/^jsxbuild([A-Z][A-Za-z0-9]*)(?:__(\w+))?$/);
            // console.log(jsxBuildMatch);
            if (jsxBuildMatch) {
                const componentName = jsxBuildMatch[1]; // e.g., MyCard
                const htmlTag = jsxBuildMatch[2] || "div"; // e.g., section, article…
                // const htmlElementType = `HTML${htmlTag[0].toUpperCase()}${htmlTag.slice(1)}Element`;
                
                const snippet = new vscode.SnippetString(
`
/**
 * ${componentName} component
 * 
 * @param props - React.HTMLAttributes<HTMLElement>
 */
function \${1:${componentName}}({children,className = '',style = {},...rest}) {
 return (
  <${htmlTag} className={className} style={style} {...rest}>
   {children}
  </${htmlTag}>
 );
}`
                );
                
                // const label = `JSX: function ${componentName} (..) { return <${htmlTag} className={className} style={style} {...rest}> ... </${htmlTag}> }`;
                const label = jsxBuildMatch[0];
                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
                item.insertText = snippet;
                item.detail = `React component <${htmlTag}> with full props`;
                // item.documentation = `Génère un composant React nommé **${componentName}** utilisant une balise **<${htmlTag}>** avec tous les props.`;
                item.documentation = `JSX: function ${componentName} (..) { return <${htmlTag} className={className} style={style} {...rest}> ... </${htmlTag}> }`;
                item.range = replaceRange;
                item.sortText = "000";
                completions.push(item);
                // let finalList = new vscode.CompletionList(completions, false);
                // return finalList;
            }
            
            const parsed = parseToken(finalToken);
            
            // Utiliser "div" par défaut si pas de tag
            const tag = parsed.tag || "div";
            const selfClosing = SELF_CLOSING.has(tag.toLowerCase());
            
            let snippet: string;
            let fakesnippet: string;
            let toFoc = 1;
            let isJsx = false;
            
            if ( escapeSnippet(finalToken) === "func" ) {
                snippet = `(param) => { \${0} }`;
                fakesnippet = `(param) =>{ | }`;
            }
            else if ( escapeSnippet(finalToken) === "greaterThan" ) {
                snippet = `>\${0}`;
                fakesnippet = `>|`;
            }
            else if ( escapeSnippet(finalToken) === "minusThan" ) {
                snippet = `<\${0}`;
                fakesnippet = `<|`;
            }
            else if ( escapeSnippet(finalToken) === "void" ) {
                snippet = `<>\${0}</>`;
                fakesnippet = `<>|</>`;
            }
            else {
                isJsx = true;
                snippet = `<${tag}`;
                fakesnippet = `<${tag}`;
            
                // Ajout des classes
                if (parsed.classes.length) {
                    snippet += ` className="${parsed.classes.join(" ")}"`;
                    fakesnippet += ` className="${parsed.classes.join(" ")}"`;
                }
                if (finalToken.includes(".") && !parsed.classes.length) {
                    snippet += ` className="\${1}"`;
                    fakesnippet += ` className="|"`;
                    toFoc++;
                }
                
                // Ajout de l'ID
                if (parsed.id) {
                    snippet += ` id="${escapeSnippet(parsed.id)}"`;
                    fakesnippet += ` id="${escapeSnippet(parsed.id)}"`;
                    toFoc++;
                }
                if (finalToken.includes("#") && !!!parsed.id) {
                    snippet += ` id="\${1}"`;
                    fakesnippet += ` id="|"`;
                }
                
                // Ajout des attributs
                if (parsed.attrs.length) {
                    snippet += " " + parsed.attrs.join(" ");
                    fakesnippet += " " + parsed.attrs.join(" ");
                }
                
                // Fermeture de la balise
                if (selfClosing) {
                    if (tag.toLocaleLowerCase() !== "img") {
                        if (!parsed.attrs.includes("alt")) {
                            snippet += ` alt="\${${toFoc}}"`;
                            fakesnippet += ` alt="|"`;
                            toFoc++;
                        }
                    }

                    snippet += " />";
                    fakesnippet += " />";
                    
                } else {
                    snippet += `>\${0}</${tag}>`;
                    fakesnippet += `>|</${tag}>`;
                }
            }
            
            
            // const label = selfClosing ? `<${tag} />` : `<${tag}>…</${tag}>`;
            const label = finalToken;
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);

            item.insertText = new vscode.SnippetString(snippet);
            item.detail = `JSX <${tag}> autocompletion`;
            item.documentation = `${isJsx ? "JSX " : "Helper "} ${fakesnippet}.`;
            item.range = replaceRange;
            
            item.filterText = rawToken;  // ← Critique pour forcer l'affichage
            item.sortText = "000";       // ← Remonte dans la liste
                        
            
            completions.push(item);
            
            // console.log("Parsed token:", rawToken, parsed);
            // console.log("Returning snippet:", snippet);
            // console.log("Completions:", completions);
            const finalList = new vscode.CompletionList(completions, true);
            // console.log("CompletionList:", finalList);
            return finalList;
        }
        
    },
    ".", "]" // "#", "[", "]", "<" // triggers
  );

  context.subscriptions.push(provider);
}

export function deactivate() {}
