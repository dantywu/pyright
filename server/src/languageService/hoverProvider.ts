/*
 * hoverProvider.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Logic that maps a position within a Python program file into
 * markdown text that is displayed when the user hovers over that
 * position within a smart editor.
 */

import { CancellationToken, Hover, MarkupKind } from 'vscode-languageserver';

import { Declaration, DeclarationType } from '../analyzer/declaration';
import { convertDocStringToMarkdown } from '../analyzer/docStringToMarkdown';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { TypeEvaluator } from '../analyzer/typeEvaluator';
import { Type, TypeCategory, UnknownType } from '../analyzer/types';
import { ClassMemberLookupFlags, isProperty, lookUpClassMember } from '../analyzer/typeUtils';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { convertOffsetToPosition, convertPositionToOffset } from '../common/positionUtils';
import { Position, Range } from '../common/textRange';
import { TextRange } from '../common/textRange';
import { NameNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import { ParseResults } from '../parser/parser';

export interface HoverTextPart {
    python?: boolean;
    text: string;
}

export interface HoverResults {
    parts: HoverTextPart[];
    range: Range;
}

export class HoverProvider {
    static getHoverForPosition(
        parseResults: ParseResults,
        position: Position,
        evaluator: TypeEvaluator,
        token: CancellationToken
    ): HoverResults | undefined {
        throwIfCancellationRequested(token);

        const offset = convertPositionToOffset(position, parseResults.tokenizerOutput.lines);
        if (offset === undefined) {
            return undefined;
        }

        const node = ParseTreeUtils.findNodeByOffset(parseResults.parseTree, offset);
        if (node === undefined) {
            return undefined;
        }

        const results: HoverResults = {
            parts: [],
            range: {
                start: convertOffsetToPosition(node.start, parseResults.tokenizerOutput.lines),
                end: convertOffsetToPosition(TextRange.getEnd(node), parseResults.tokenizerOutput.lines),
            },
        };

        if (node.nodeType === ParseNodeType.Name) {
            const declarations = evaluator.getDeclarationsForNameNode(node);
            if (declarations && declarations.length > 0) {
                this._addResultsForDeclaration(results.parts, declarations[0], node, evaluator);
            } else if (!node.parent || node.parent.nodeType !== ParseNodeType.ModuleName) {
                // If we had no declaration, see if we can provide a minimal tooltip. We'll skip
                // this if it's part of a module name, since a module name part with no declaration
                // is a directory (a namespace package), and we don't want to provide any hover
                // information in that case.
                if (results.parts.length === 0) {
                    const type = evaluator.getType(node) || UnknownType.create();

                    let typeText = '';
                    if (type.category === TypeCategory.Module) {
                        // Handle modules specially because submodules aren't associated with
                        // declarations, but we want them to be presented in the same way as
                        // the top-level module, which does have a declaration.
                        typeText = '(module) ' + node.value;
                    } else {
                        typeText = node.value + ': ' + evaluator.printType(type);
                    }

                    this._addResultsPart(results.parts, typeText, true);
                    this._addDocumentationPart(results.parts, node, evaluator);
                }
            }
        }

        return results.parts.length > 0 ? results : undefined;
    }

    private static _addResultsForDeclaration(
        parts: HoverTextPart[],
        declaration: Declaration,
        node: NameNode,
        evaluator: TypeEvaluator
    ): void {
        const resolvedDecl = evaluator.resolveAliasDeclaration(declaration);
        if (!resolvedDecl) {
            this._addResultsPart(parts, `(import) ` + node.value + this._getTypeText(node, evaluator), true);
            return;
        }

        switch (resolvedDecl.type) {
            case DeclarationType.Intrinsic: {
                this._addResultsPart(parts, node.value + this._getTypeText(node, evaluator), true);
                this._addDocumentationPart(parts, node, evaluator);
                break;
            }

            case DeclarationType.Variable: {
                const label = resolvedDecl.isConstant || resolvedDecl.isFinal ? 'constant' : 'variable';
                this._addResultsPart(parts, `(${label}) ` + node.value + this._getTypeText(node, evaluator), true);
                this._addDocumentationPart(parts, node, evaluator);
                break;
            }

            case DeclarationType.Parameter: {
                this._addResultsPart(parts, '(parameter) ' + node.value + this._getTypeText(node, evaluator), true);
                this._addDocumentationPart(parts, node, evaluator);
                break;
            }

            case DeclarationType.Class:
            case DeclarationType.SpecialBuiltInClass: {
                let classText = node.value;

                // If the class is used as part of a call (i.e. it is being
                // instantiated), include the constructor arguments within the
                // hover text.
                let callLeftNode: ParseNode | undefined = node;

                // Allow the left to be a member access chain (e.g. a.b.c) if the
                // node in question is the last item in the chain.
                if (
                    callLeftNode.parent &&
                    callLeftNode.parent.nodeType === ParseNodeType.MemberAccess &&
                    node === callLeftNode.parent.memberName
                ) {
                    callLeftNode = node.parent;
                }

                if (
                    callLeftNode &&
                    callLeftNode.parent &&
                    callLeftNode.parent.nodeType === ParseNodeType.Call &&
                    callLeftNode.parent.leftExpression === callLeftNode
                ) {
                    // Get the init method for this class.
                    const type = evaluator.getType(node);
                    if (type && type.category === TypeCategory.Class) {
                        const initMethodMember = lookUpClassMember(
                            type,
                            '__init__',
                            ClassMemberLookupFlags.SkipInstanceVariables | ClassMemberLookupFlags.SkipObjectBaseClass
                        );
                        if (initMethodMember) {
                            const initMethodType = evaluator.getTypeOfMember(initMethodMember);
                            if (initMethodType && initMethodType.category === TypeCategory.Function) {
                                const functionParts = evaluator.printFunctionParts(initMethodType);
                                classText += `(${functionParts[0].join(', ')})`;
                            }
                        }
                    }
                }

                this._addResultsPart(parts, '(class) ' + classText, true);
                this._addDocumentationPart(parts, node, evaluator);
                break;
            }

            case DeclarationType.Function: {
                let label = 'function';
                if (resolvedDecl.isMethod) {
                    const declaredType = evaluator.getTypeForDeclaration(resolvedDecl);
                    label = declaredType && isProperty(declaredType) ? 'property' : 'method';
                }

                this._addResultsPart(parts, `(${label}) ` + node.value + this._getTypeText(node, evaluator), true);
                this._addDocumentationPart(parts, node, evaluator);
                break;
            }

            case DeclarationType.Alias: {
                this._addResultsPart(parts, '(module) ' + node.value, true);
                this._addDocumentationPart(parts, node, evaluator);
                break;
            }
        }
    }

    private static _getTypeText(node: NameNode, evaluator: TypeEvaluator): string {
        const type = evaluator.getType(node) || UnknownType.create();
        return ': ' + evaluator.printType(type);
    }

    private static _addDocumentationPart(parts: HoverTextPart[], node: NameNode, evaluator: TypeEvaluator) {
        const type = evaluator.getType(node);
        if (type) {
            this._addDocumentationPartForType(parts, type);
        }
    }

    private static _addDocumentationPartForType(parts: HoverTextPart[], type: Type) {
        if (type.category === TypeCategory.Module) {
            this._addDocumentationResultsPart(parts, type.docString);
        } else if (type.category === TypeCategory.Class) {
            this._addDocumentationResultsPart(parts, type.details.docString);
        } else if (type.category === TypeCategory.Function) {
            this._addDocumentationResultsPart(parts, type.details.docString);
        } else if (type.category === TypeCategory.OverloadedFunction) {
            type.overloads.forEach((overload) => {
                this._addDocumentationResultsPart(parts, overload.details.docString);
            });
        }
    }

    private static _addDocumentationResultsPart(parts: HoverTextPart[], docString?: string) {
        if (docString) {
            this._addResultsPart(parts, convertDocStringToMarkdown(docString));
        }
    }

    private static _addResultsPart(parts: HoverTextPart[], text: string, python = false) {
        parts.push({
            python,
            text,
        });
    }
}

export function convertHoverResults(hoverResults: HoverResults | undefined): Hover | undefined {
    if (!hoverResults) {
        return undefined;
    }

    const markupString = hoverResults.parts
        .map((part) => {
            if (part.python) {
                return '```python\n' + part.text + '\n```\n';
            }
            return part.text;
        })
        .join('');

    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: markupString,
        },
        range: hoverResults.range,
    };
}
