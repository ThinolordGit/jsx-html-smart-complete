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

function sanitizeFinalTokenWithRecovery(token: string): string | null {
  let bracketBalance = 0;
  let i = 0;
  let recoverStartIndex = -1;
  let foundRecoverable = true;

  while (i < token.length) {
    const ch = token[i];

    if (ch === "[") {
      bracketBalance++;
      i++;
      continue;
    }

    if (ch === "]") {
      if (bracketBalance === 0) {
        i++;
        recoverStartIndex = i;
        continue;
      }
      else {
        i++;
        bracketBalance--;
        continue;
      }
    }
    
    if (bracketBalance > 0) {
      i++;
      continue;
    }

    if (/[.#\[A-Za-z0-9_-]/.test(ch)) {
      if (recoverStartIndex === -1) {
        recoverStartIndex = i;
      }
      if (ch === '.' || ch === '#' || ch === '[') {
        foundRecoverable = true;
      }
      i++;
      continue;
    }

    // Fin dès qu'on touche un char non valide
    break;
  }

  if (recoverStartIndex !== -1) {
    let res = token.slice(recoverStartIndex, i);
    // console.log(res);
    return res;
  }

  return null;
}


function computeValidPostLength(rawToken: string, postToken: string, finalToken: string): number {
  const from = rawToken.length;
  const wantedPost = finalToken.slice(from);
  let validLength = 0;

  // On veut savoir combien de caractères initiaux de postToken sont restés dans wantedPost
  for (let i = 0; i < postToken.length && i < wantedPost.length; i++) {
    if (postToken[i] !== wantedPost[i]) break;
    validLength++;
  }

  return validLength;
}

function getValidTokenRangeAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position
): { token: string, range: vscode.Range } | null {
  const line = document.lineAt(position.line).text;
  
  let start = position.character;
  let end = position.character;
  
  // Reculer pour trouver le début
  while (start > 0 && /[.#\[\]\{\}\>\'A-Za-z0-9="_-]/.test(line[start - 1])) {
    start--;
  }

  // Avancer pour trouver la fin
  while (end < line.length && /[.#\[\]\{\}\>\'A-Za-z0-9="_-]/.test(line[end])) {
    end++;
  }
  
  const rawToken = line.slice(start, position.character);
  const postToken = line.slice(position.character, end);
  const combined = rawToken + postToken;
  const sanitized = sanitizeFinalTokenWithRecovery(combined);

  if (!sanitized) return null;

  // console.log("sanitized :",sanitized);

  // On recalcule la vraie longueur utile à remplacer (comme tu l’as dit plus tôt)
  const postLength = computeValidPostLength(rawToken, postToken, sanitized);

  const fullReplaceRange = new vscode.Range(
    new vscode.Position(position.line, start),
    new vscode.Position(position.line, position.character + postLength)
  );

  return {
    token: sanitized,
    range: fullReplaceRange
  };
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
  const postToken = line.substring(position.character, forwardIdx) || ""; // après curseur

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

    
    // if ( token.length >= i ) {
    //     if ( !/[.#\[A-Za-z0-9_-]/.test(token[i]) ){
    //         return {
    //             tag: undefined as string | undefined,
    //             classes: [] as string[],
    //             id: undefined as string | undefined,
    //             attrs: [] as string[],
    //             endsWith: null as ('.' | '#' | '[' | null)
    //         };
    //     }
    // }
    
    // if ( !/[.#\]A-Za-z0-9_-]/.test(lastChar)){
    //     return {
    //         tag: undefined as string | undefined,
    //         classes: [] as string[],
    //         id: undefined as string | undefined,
    //         attrs: [] as string[],
    //         endsWith: null as ('.' | '#' | '[' | null)
    //     };
    // }
    
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
// function makeCompletionDefault({label="snippets",insertText,documentation,detail,sortText='000'}, replaceRange: vscode.Range | null) {
//   let insert: vscode.SnippetString = insertText;
//   const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
//   item.insertText = insert;
//   if (replaceRange) item.range = replaceRange;
//   item.detail = detail;
//   item.documentation = new vscode.MarkdownString(documentation);
//   item.sortText = sortText;
//   return item;
// }

function makeCompletion({label="snippets",snippet,tag=null,fakesnippet,sortText='000'}, replaceRange: vscode.Range | null,isJsx: boolean = true) {
  
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
              
  item.insertText = new vscode.SnippetString(snippet);
  item.detail = tag ? `JSX <${tag}> autocompletion` : `JSX autocompletion`;
  item.documentation = `${isJsx ? "JSX " : "Helper "} ${fakesnippet}.`;
  item.range = replaceRange;
  item.sortText = sortText;   
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
              
            const result = getValidTokenRangeAtCursor(document, position);
            if (!result) return undefined;
            // console.log(result);
            const { token: finalToken, range: replaceRange } = result;
            
            if (!finalToken && ctx.triggerKind !== vscode.CompletionTriggerKind.TriggerForIncompleteCompletions) {
                return undefined;
            }
            
            const completions: vscode.CompletionItem[] = [];
            
            
            
            // const escapedToken = escapeSnippet(finalToken);
            
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
function \${1:${componentName}} ({children,className = '',style = {},...rest}) {
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
                item.detail = `React component <${htmlTag}> with props`;
                // item.documentation = `Génère un composant React nommé **${componentName}** utilisant une balise **<${htmlTag}>** avec les props.`;
                item.documentation = `JSX: function ${componentName} (..) { return <${htmlTag} className={className} style={style} {...rest}> | </${htmlTag}> }`;
                item.range = replaceRange;
                item.sortText = "000";
                completions.push(item);
                // let finalList = new vscode.CompletionList(completions, false);
                // return finalList;
            }

            if (/^js/.test(finalToken)) {
             const hintItem = new vscode.CompletionItem(
                 "💡jsxbuildXcomponent__tagName pour créer un composant React",
                 vscode.CompletionItemKind.Snippet
             );
             hintItem.insertText = `
/**
 * Xcomponent component
 * 
 * @param props - React.HTMLAttributes<HTMLElement>
 */
function \${1:Xcomponent} ({children,className = '',style = {},...rest}) {
 return (
  <tagName className={className} style={style} {...rest}>
   {children}
  </tagName>
 );
}`; // Ne remplace rien
             hintItem.detail = "Ex: jsxbuildCard__section → function Card() { return <section> }";
             hintItem.documentation = new vscode.MarkdownString(
                 `👉 Pour générer un **composant React** avec props auto-gérés, tape \`jsxbuildNom__balise\`.\n\n**Exemples** :\n- \`jsxbuildCard__section\`\n- \`jsxbuildHeader__header\``
             );
             hintItem.range = replaceRange;
             hintItem.sortText = "001"; // Position basse
             completions.push(hintItem);
            }
            
            
            const parsed = parseToken(finalToken);
            
            // Utiliser "div" par défaut si pas de tag
            const tag = parsed.tag || "div";
            const selfClosing = SELF_CLOSING.has(tag.toLowerCase());
            
            let snippet: string;
            let fakesnippet: string;
            let toFoc = 1;
            let mapSnippet: {snip: string;fsnip: string;isJsx: boolean;}[]= [];
            if ( escapeSnippet(finalToken).startsWith ("fun") ) {
              snippet = `(\${1:param}) => { \${0} }`;
              fakesnippet = `(\`param\`) =>{ | }`;
              mapSnippet.push({snip:snippet,fsnip:fakesnippet, isJsx:false});
            }
            if ( escapeSnippet(finalToken).startsWith ("fun") ) {
              snippet = `() => { \${0} }`;
              fakesnippet = `() =>{ | }`;
              mapSnippet.push({snip:snippet,fsnip:fakesnippet, isJsx:false});
            }
            
            if ( escapeSnippet(finalToken) === "func" ) {
              snippet = `(param) => { \${0} }`;
              fakesnippet = `(param) =>{ | }`;
              mapSnippet.push({snip:snippet,fsnip:fakesnippet, isJsx:false});
            }
            
            if ( escapeSnippet(finalToken) === "greaterThan" || escapeSnippet(finalToken) === "sup") {
              snippet = `>\${0}`;
              fakesnippet = `>|`;
              mapSnippet.push({snip:snippet,fsnip:fakesnippet, isJsx:false});
            }
            
            if ( escapeSnippet(finalToken) === "minusThan" || escapeSnippet(finalToken) === "inf") {
              snippet = `<\${0}`;
              fakesnippet = `<|`;
              mapSnippet.push({snip:snippet,fsnip:fakesnippet, isJsx:false});
            }
            
            if ( escapeSnippet(finalToken) === "void" ) {
              snippet = `<>\${0}</>`;
              fakesnippet = `<>|</>`;
              mapSnippet.push({snip:snippet,fsnip:fakesnippet, isJsx:false});
            }

            // else {
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
                    
              } 
              else {
                  snippet += `>\${0}</${tag}>`;
                  fakesnippet += `>|</${tag}>`;
              }
              mapSnippet.push({snip:snippet,fsnip:fakesnippet, isJsx:true});
            // }
            
            console.log("Token", finalToken);
            // console.log("Post token", postToken);
            
            for (let snipp of mapSnippet) {
              const item = makeCompletion(
                { label: finalToken, snippet: snipp.snip, fakesnippet: snipp.fsnip },
                replaceRange,
                snipp.isJsx
              );
              completions.push(item);
            }
            
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
