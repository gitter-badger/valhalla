'use babel';

import * as fs from 'fs';
import * as path from 'path';
import ScopeManager from './scopes';
import keywords from './keywords';

export default class ValaProvider {
    constructor() {
        const vapiDir = atom.config.get('valhalla.vapiDir');

        this.re = {
            using: /^using /,
            usingLine: /^using (.*);/,
            newInstance: /([\w\.]+) [\w\.]+ = new /,
            par: /\(.*\)/,
            escapePrefix: /[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g,
            thisMember: /this\./,
            tis: /this/,
        };

        this.manager = new ScopeManager();

        atom.workspace.observeTextEditors((editor) => {
            if (editor.getPath() && editor.getPath().endsWith('.vala')) {
                editor.onDidStopChanging((event) => {
                    this.manager.parse(editor.getText(), editor.getPath());
                });
                this.manager.parse(editor.getText(), editor.getPath());
            }
        });

        // autocomplete-plus properties
        this.selector = '.source.vala';
        this.disableForSelector = '.source.vala .comment, .source.vala .string';
        this.inclusionPriority = 10;
        this.excludeLowerPriority = true;

        // loading symbols from .vapi
        fs.readdir (vapiDir, (err, files) => {
            if (err) {
                console.error (err);
                return;
            }

            for (file of files) {
                if (file.endsWith('.vapi')) {
                    let content = fs.readFileSync(path.join(vapiDir, file), 'utf-8');
                    this.manager.parse(content, file);
                }
            }
        });
    }

    getSuggestions ({editor, bufferPosition, scopeDescriptor, prefix, activatedManually}) {
        this.manager.scopes.sort((a, b) => {
            if (a.vapi && !b.vapi) {
                return -1;
            }

            if (b.vapi && !a.vapi) {
                return 1;
            }

            return 0;
        });
        var line = editor.getTextInRange([[bufferPosition.row, 0], bufferPosition]);
        var usings = ['GLib'];
        let i = 1, endUsing = 0;
        for (ln of editor.getText().split('\n')) {
            var usingMatch = ln.match (this.re.usingLine);
            if (usingMatch) {
                usings.push(usingMatch[1]);
                endUsing = i;
            }
            // TODO: add ns of the curent file to usings
            i++;
        }

        return new Promise ((resolve) => {
            var suggestions = [];
            let thisScope;
            let currentScope; // the scope in which we are typing

            // matches
            let usingMatch = line.match (this.re.using);
            let newMatch = line.match (this.re.newInstance);

            let removeEnums = false;

            let trimLine = line.trim ();
            let shouldSuggestClasses = trimLine[0] == trimLine[0].toUpperCase () && trimLine == prefix;
            let shouldSuggestStructs = trimLine == prefix;
            let shouldSuggestInherits = (trimLine.includes('class ') || trimLine.includes('interface ')) && trimLine.includes(' : ');

            // explores a scopes and get suggestions from it, if needed
            let explore = (scope) => {

                // determining scope corresponding to `this`
                if (scope.file == editor.getPath() && scope.at[0][0] <= bufferPosition.row && scope.at[1][0] >= bufferPosition.row + 1) {
                    if (!thisScope && scope.data && scope.data.type == 'class') {
                        thisScope = scope;
                    }
                }

                // usings
                if (usingMatch) {
                    // if scope is a namespace and matches the using
                    if (scope.data && scope.data.type == 'namespace') {

                        // get parent namespaces
                        let name = scope.data.name;
                        let getParents = (scope) => {
                            if (scope.top && scope.top.data && scope.top.data.type == 'namespace') {
                                name = scope.top.data.name + '.' + name;
                                getParents (scope.top);
                            }
                        }
                        getParents (scope);

                        if (name.match (prefix) || prefix == ' ') {
                            // show suggestion
                            let suggestion = {
                                text: name + ';',
                                type: 'import',
                                displayText: name,
                                description: `The ${name} namespace.`
                            };
                            suggestions.push (suggestion);
                        }
                    }
                }

                // Suggesting classes or interfaces
                if (shouldSuggestClasses) {
                    // first letter is a capital letter
                    if (scope.data && (scope.data.type == 'class' || scope.data.type == 'interface') && scope.data.name.startsWith (trimLine)) {
                        let suggestion = {
                            text: scope.data.name,
                            type: scope.data.type,
                            description: `The ${scope.data.name} ${scope.data.type}.`
                        };
                        suggestions.push (suggestion);
                    }
                }

                // suggest classes and interface from which you can inherits
                if (shouldSuggestInherits) {
                    if (scope.data && (scope.data.type == 'class' || scope.data.type == 'interface') && (scope.data.name.startsWith(prefix) || prefix == ' ')) {
                        let suggestion = {
                            text: scope.data.name,
                            displayText: scope.data.name,
                            type: scope.data.type
                        }
                        suggestions.push(suggestion);
                    }
                }

                // suggest structs
                if (shouldSuggestStructs) {
                    if (scope.data && scope.data.type == 'struct' && scope.data.name.startsWith(prefix)) {
                        suggestions.push({
                            type: 'struct',
                            text: scope.data.name + ' ',
                            displayText: scope.data.name,
                            description: `The ${scope.data.name} struct.`
                        });
                    }
                }

                // for instance :
                // Value v =
                // will show `Value`
                // TODO : don't show it if there is a [*Type] attribute ([IntegerType], [BooleanType] ...) because we write literal value for these types
                if (scope.data && scope.data.type == 'struct' && trimLine.endsWith(' =' + (prefix == ' ' ? '' : ' ' + prefix)) && trimLine.split(' ')[0] == scope.data.name) {
                    suggestions.push({
                        type: 'struct',
                        snippet: scope.data.name + ' ($1);',
                        displayText: scope.data.name
                    });
                }

                // creating new instances
                if (newMatch) {
                    // TODO : give priority to classes in used namespaces
                    // TODO : make this line looking less encrypted
                    if (scope.data && scope.data.type == 'class' && (scope.data.name == newMatch[1] || (scope.data.inherits && scope.data.inherits.replace(' ', '').split(',').map((elt) => {
                        let splitted = elt.split('.'); return splitted[splitted.length - 1];
                    }).includes(newMatch[1])))) {
                        for (ch of scope.children) {
                            if (ch.data && ch.data.type == 'ctor') {
                                let suggestion = this.suggestMethod(ch);

                                if (prefix == ' ' || suggestion.displayText.match(prefix)) {
                                    suggestions.push (suggestion);
                                }
                            }
                        }
                    }
                }

                // show local variables
                if (scope.file == editor.getPath() && scope.at[0][0] <= bufferPosition.row && scope.at[1][0] >= bufferPosition.row) {
                    currentScope = scope;
                    for (localVar of scope.vars) {
                        if (localVar.name.startsWith(prefix) || trimLine == '' && localVar.line <= bufferPosition.row) {
                            let suggestion = {
                                text: localVar.name,
                                type: 'variable',
                                leftLabel: localVar.type,
                                description: localVar.documentation ? localVar.documentation : ''
                            };
                            suggestions.push (suggestion);
                        }
                    }

                    // we also suggest instance properties/methods for these variables
                    if (trimLine.endsWith(prefix == '.' ? '.' : '.' + prefix)) {
                        let parCount = 0;
                        for (let i = trimLine.length - 1; i >= 0; i--) {
                            // TODO : ignore literals
                            const ch = trimLine[i];
                            if (ch == '(') parCount++;
                            if (ch == ')') parCount--;
                            if (parCount == 1 || ch == '=' || i == 0) {
                                // we are at the beginning of the current expression
                                let expr = trimLine.slice(i, trimLine.length).replace('=', '').trim();
                                if (expr.endsWith('.')) {
                                    expr = expr.slice(0, expr.length - 1);
                                }
                                const splitExpr = expr.split('.');
                                for (localVar of scope.vars) { // TODO take only current scopes
                                    if (localVar.name == splitExpr[0]) {
                                        console.log('gonna get type :', localVar.type, scope.file);
                                        const type = this.getType(localVar.type, splitExpr.slice(1, splitExpr.length - 1).join('.'), usings);
                                        console.log('Type :', type);
                                        for (member of type.children) {
                                            if (member.data && member.data.name && (member.data.name.startsWith(prefix) || prefix == '.')) {
                                                switch (member.data.type) {
                                                    case 'method':
                                                        suggestions.push(this.suggestMethod(member));
                                                        break;
                                                    case 'property':
                                                        suggestions.push(this.suggestProperty(member));
                                                        break;
                                                    default:
                                                        break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                }

                // member of this
                if (thisScope && line.endsWith ('this' + (prefix == '.' ? prefix : '.' + prefix)) && scope.top == thisScope && scope.data.type != 'ctor' && scope.data.name.match (prefix == '.' ? /.*/ : prefix)) {
                    suggestions.unshift ({
                        type: scope.data.type,
                        text: scope.data.name
                    });
                }

                // static methods
                if (scope.data && scope.data.type == 'method' && (scope.data.modifier == 'static' || (scope.top.data && (scope.top.data.type == 'namespace' || scope.top.data.type == 'global')))) {
                    if (scope.top.data) {
                        // TODO : show methods that are in the current namespace
                        if (scope.top.data.type == 'global' && scope.data.name.startsWith(prefix)) {
                            suggestions.push(this.suggestMethod(scope));
                        } else if (scope.top.data.type == 'namespace' && usings.includes(scope.top.data.name) && scope.data.name.startsWith(prefix)) {
                            // TODO : support nested namespaces
                            suggestions.push(this.suggestMethod(scope));
                        } else if (scope.top.data.type == 'class' && scope.data.modifier == 'static' && trimLine.endsWith((scope.top.data.name + (prefix == '.' ? '.' : '.' + prefix))) && (scope.data.name.startsWith(prefix) || prefix == '.')) {
                            suggestions.push(this.suggestMethod(scope));
                        }
                    }
                }

                // enumerations
                if (scope.data && scope.data.type == 'enum') {
                    const wantValues = trimLine.endsWith(scope.data.name + (prefix == '.' ? '.' : '.' + prefix));
                    // TODO : show enums only when really needed
                    if (scope.data.name.startsWith(prefix) && !wantValues) {
                        suggestions.push ({
                            text: scope.data.name,
                            type: 'enum',
                            description: `The ${scope.data.name} enum.`
                        });
                    } else if (wantValues) {
                        for (val of scope.data.values) {
                            if (val.trim().startsWith(prefix) || prefix == '.') {
                                suggestions.push({
                                    text: val.trim(),
                                    type: 'value'
                                });
                                removeEnums = true;
                            }
                        }
                    }
                }

                // explore children
                for (child of scope.children) {
                    explore (child);
                }
            }

            for (scope of this.manager.scopes) {
                explore (scope);
            }

            if (currentScope && currentScope.data) {
                // TODO: support scopes like class.ctor
                // TODO : if scope type is unknown (if you are in a if for instance) it don't show anything
                const type = currentScope.data.type;
                for (kw of keywords) {
                    if (kw.scope.split(', ').includes(type) && kw.name.startsWith (prefix)) {
                        suggestions.unshift ({
                            snippet: kw.completion,
                            displayText: kw.name,
                            type: 'keyword',
                            description: `The ${kw.name} keyword.`
                        });
                    }
                }
            }

            if (trimLine != '') {
                console.log('Resolving !', thisScope);
                if (removeEnums) {
                    suggestions = suggestions.filter((sugg) => {
                        return sugg.type != 'enum';
                    });
                }
                suggestions = suggestions.sort ((a, b) => {
                    if (a.displayText == prefix) {
                        return -1;
                    }
                    if (b.displayText == prefix) {
                        return 1;
                    }
                    return 0;
                })
                resolve(suggestions);
            }
        });
    }

    suggestMethod (scope) {

        if (!(scope.data && (scope.data.type == 'method' || scope.data.type == 'ctor'))) return;

        let snip = scope.data.name + ' (';
        let count = 1;
        let paramList = [];
        if (scope.data.parsedParameters) {
            for (param of scope.data.parsedParameters) {
                paramList.push ((param.modifier ? param.modifier + ' ' : '') + '${' + count + ':' + param.name + '}');
                count++;
            }
        }
        snip += paramList.join (', ');
        snip += ');$' + count;
        let suggestion = {
            snippet: snip,
            type: scope.data.type == 'method' ? 'method' : 'class',
            displayText: scope.data.name,
            leftLabel: (scope.data.returnType ? ((scope.data.modifier == 'static' ? 'static ' : '') + scope.data.returnType) : ''),
            description: scope.documentation.short ? scope.documentation.short : (scope.data.type == 'method' ? `The ${scope.data.name} method.` : `Creates a new instance of ${scope.top.data.name}.`)
        };

        return suggestion;
    }

    suggestProperty (scope) {
        if (scope.data && scope.data.type == 'property') {
            return {
                text: scope.data.name,
                leftLabel: (scope.data.modifier == 'static' ? '(static) ' : '') + scope.data.valueType,
                type: 'property'
            };
        }
    }

    getType (type, expr, usings) {
        console.log('getting type for :', type, expr, usings);
        // removing method's parameters and spaces
        while (expr && expr.match(this.re.par)) {
            expr = expr.replace(this.re.par, '');
            expr = expr.replace(' ', '');
        }

        if (typeof type == 'string') {
            let res;
            let nsName;
            let shortTypeName = type;
            if (type.includes('.')) {
                const typeParts = type.split('.');
                nsName = typeParts.slice(0, typeParts.length - 1).join('.');
                shortTypeName = typeParts[typeParts.length - 1];
            }

            let ns;
            let explore = (scope, everything) => {
                if (!scope.data) { return; }

                if (scope.data.type == 'global' || scope.data.type == 'namespace') {
                    if (!everything) {
                        // search only in used namespaces or specified namespace
                        if (nsName && scope.data.name == nsName) { // TODO : support nested namespaces
                            ns = scope;
                            for (ch of scope.children) {
                                explore(ch, everything);
                            }
                        } else if (!nsName && usings.includes(scope.data.name)) { // TODO : support nested namespaces
                            ns = scope;
                            for (ch of scope.children) {
                                explore(ch, everything);
                            }
                        } else if (scope.data.type == 'global') {
                            for (ch of scope.children) {
                                explore(ch, everything);
                            }
                        }
                    } else {
                        for (ch of scope.children) {
                            explore(ch, everything);
                        }
                    }
                } else if (scope.data.type == 'class' || scope.data.type == 'interface' || scope.data.type == 'struct') {
                    if (scope.data.name == shortTypeName) {
                        res = scope;
                    }
                }
            }

            for (child of this.manager.scopes) {
                explore(child, false);
            }

            if (!res) {
                for (child of this.manager.scopes) {
                    explore(child, true);
                }
            }

            if (!expr) {
                return res;
            } else {
                return this.getType(res, expr, usings);
            }
        } else if (type) {
            // we have got a scope
            if (expr.includes('.')) {
                let t = type;
                for (subExpr in expr.split('.')) {
                    t = this.getType(t, subExpr, usings);
                }
                return t;
            } else {
                for (ch of type.children) {
                    if (ch.data && ch.data.name == expr) {
                        return this.getType(ch.data.valueType ? ch.data.valueType : ch.data.returnType); // return scope, not name
                    }
                }
            }
        } else {
            return {
                data: {
                    name: 'void'
                }
            };
        }

        /*
            on détermine exactement le type de base grâce aux usings
            si conflit, on prends le premier

            après ça, bugs = 0

            ------------

            find scopes for used ns
            explore them and try to find a matching type
            if found -> take it
            else -> search all scopes (only global and ns in fact)
        */



        /*







        // TODO : if namespace is specified in type, don't search in others

        // removing methods arguments and spaces


        if (expr.includes('.')) {
            let t = type;
            for (subEx of expr.split('.')) {
                t = this.getType(t, subEx);
            }
            return t;
        } else {
            let t;
            let explore = (scope, everything) => {
                if (scope.data.type == 'global' || (scope.data.type == 'namespace' && usings.includes('namespace'))) {
                    for (ch of scope.children) {
                        if ((ch.data.type == 'class' || ch.data.type == 'interface' || ch.data.type == 'struct') && ch.data.name) {

                        }
                    }
                    // priority
                } else if (everything) {

                }


                if (scope.data && scope.data.type == 'class' && scope.data.name == type) {
                    t = scope;
                } else {
                    for (child of scope.schildren) {
                        explore (child);
                    }
                }
            }

            for (scope of this.manager.scopes) {
                explore (scope);
            }

            if (t) {
                for (var child of t.children) {
                    if (child.data && child.data.type == 'method' && child.data.name == expr) {
                        let res = child.data.returnType.split('.');
                        return res[res.length - 1];
                    } else if (child.data && child.data.type == 'property' && child.data.name == expr) {
                        let res =  child.data.valueType.split('.');
                        return res[res.length - 1];
                    }
                }
            }
            return 'void';
        }*/
    }

    onDidInsertSuggestion ({editor, triggerPosition, suggestion}) {
        if (suggestion.afterInsert) {
            suggestion.afterInsert(editor);
        }
    }
}
