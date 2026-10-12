use crate::analyzer::{FlowEdge, FlowGraph, FlowNode, FunctionInfo, FunctionReference};
use tree_sitter::{Node, Parser, Tree};

#[derive(Clone)]
struct Exit {
    node: String,
    label: String,
}

#[derive(Clone, Default)]
struct ControlContext {
    break_target: Option<String>,
    continue_target: Option<String>,
}

struct Definition<'tree> {
    node: Node<'tree>,
    body: Node<'tree>,
    info: FunctionInfo,
    unqualified_name: String,
    containing_type: Option<String>,
    static_member: bool,
    top_level: bool,
}

struct GraphBuilder<'source, 'tree> {
    source: &'source str,
    root: Node<'tree>,
    console_is_standard: bool,
    nodes: Vec<FlowNode>,
    edges: Vec<FlowEdge>,
    next_node: usize,
    next_edge: usize,
}

impl<'source, 'tree> GraphBuilder<'source, 'tree> {
    fn new(source: &'source str, root: Node<'tree>) -> Self {
        Self {
            source,
            root,
            console_is_standard: !has_value_binding(source, root, "Console")
                && !has_value_binding(source, root, "System")
                && !custom_console(source, root),
            nodes: Vec::new(),
            edges: Vec::new(),
            next_node: 0,
            next_edge: 0,
        }
    }

    fn add_node(&mut self, label: String, kind: &str, node: Node<'_>) -> String {
        self.add_node_at(
            label,
            kind,
            node.start_position().row + 1,
            node.start_byte(),
            node.end_byte(),
        )
    }

    fn add_node_at(
        &mut self,
        label: String,
        kind: &str,
        line: usize,
        start_byte: usize,
        end_byte: usize,
    ) -> String {
        let id = format!("node-{}", self.next_node);
        self.next_node += 1;
        self.nodes.push(FlowNode {
            id: id.clone(),
            label,
            kind: kind.to_owned(),
            line,
            start_byte,
            end_byte,
            source_identity: source_identity(self.source, self.root, kind, start_byte, end_byte),
            header_identity: None,
            loop_condition: None,
            comments: Vec::new(),
        });
        id
    }

    fn add_edge(&mut self, source: &str, target: &str, label: &str) {
        let id = format!("edge-{}", self.next_edge);
        self.next_edge += 1;
        self.edges.push(FlowEdge {
            id,
            source: source.to_owned(),
            target: target.to_owned(),
            label: label.to_owned(),
        });
    }

    fn connect(&mut self, exits: &[Exit], target: &str) {
        for exit in exits {
            self.add_edge(&exit.node, target, &exit.label);
        }
    }

    fn set_header(&mut self, id: &str, node: Node<'_>) {
        let identity = source_identity(
            self.source,
            self.root,
            "header",
            node.start_byte(),
            node.end_byte(),
        );
        if let Some(flow_node) = self.nodes.iter_mut().find(|flow_node| flow_node.id == id) {
            flow_node.header_identity = Some(identity);
        }
    }

    fn set_loop_condition(&mut self, id: &str, condition: Option<Node<'_>>) {
        if let Some(flow_node) = self.nodes.iter_mut().find(|flow_node| flow_node.id == id) {
            flow_node.loop_condition = condition.map(|node| clean_text(self.source, node));
        }
    }

    fn process_sequence(
        &mut self,
        statements: Vec<Node<'_>>,
        mut incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        let mut simple = Vec::new();
        for statement in statements {
            if matches!(statement.kind(), "comment" | "local_function_statement") {
                continue;
            }
            if is_simple(statement) {
                if let Some(previous) = simple.last().copied() {
                    if is_console_io(self.source, self.console_is_standard, previous)
                        != is_console_io(self.source, self.console_is_standard, statement)
                    {
                        incoming = self.process_simple(std::mem::take(&mut simple), incoming);
                    }
                }
                simple.push(statement);
                continue;
            }
            if !simple.is_empty() {
                incoming = self.process_simple(std::mem::take(&mut simple), incoming);
            }
            incoming = self.process_statement(statement, incoming, context);
        }
        if !simple.is_empty() {
            incoming = self.process_simple(simple, incoming);
        }
        incoming
    }

    fn process_statement(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        match statement.kind() {
            "global_statement" => first_named_child(statement)
                .map(|child| self.process_statement(child, incoming.clone(), context))
                .unwrap_or(incoming),
            "block" => self.process_sequence(named_children(statement), incoming, context),
            "if_statement" => self.process_if(statement, incoming, context),
            "for_statement" | "foreach_statement" | "while_statement" => {
                self.process_loop(statement, incoming, context)
            }
            "do_statement" => self.process_do_loop(statement, incoming),
            "switch_statement" => self.process_switch(statement, incoming, context),
            "return_statement" => self.process_terminal(statement, incoming, "return", "Return"),
            "throw_statement" => self.process_terminal(statement, incoming, "throw", "Throw"),
            "break_statement" => {
                self.process_jump(statement, incoming, "break", "Break", &context.break_target)
            }
            "continue_statement" => self.process_jump(
                statement,
                incoming,
                "continue",
                "Continue",
                &context.continue_target,
            ),
            "local_function_statement" | "comment" | "empty_statement" => incoming,
            _ => self.process_simple(vec![statement], incoming),
        }
    }

    fn process_simple(&mut self, statements: Vec<Node<'_>>, incoming: Vec<Exit>) -> Vec<Exit> {
        if incoming.is_empty() {
            return incoming;
        }
        let Some(first) = statements.first().copied() else {
            return incoming;
        };
        let last = *statements.last().expect("non-empty statements");
        let label = statements
            .iter()
            .map(|statement| clean_statement(&text_without_comments(self.source, *statement)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if label.is_empty() {
            return incoming;
        }
        let kind = if statements
            .iter()
            .all(|statement| is_console_io(self.source, self.console_is_standard, *statement))
        {
            "io"
        } else {
            "process"
        };
        let id = self.add_node_at(
            label,
            kind,
            first.start_position().row + 1,
            first.start_byte(),
            last.end_byte(),
        );
        self.connect(&incoming, &id);
        vec![Exit {
            node: id,
            label: String::new(),
        }]
    }

    fn process_terminal(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        kind: &str,
        fallback: &str,
    ) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let label = clean_statement(&text_without_comments(self.source, statement));
        let id = self.add_node(
            if label.is_empty() {
                fallback.to_owned()
            } else {
                label
            },
            kind,
            statement,
        );
        self.connect(&incoming, &id);
        Vec::new()
    }

    fn process_jump(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        kind: &str,
        label: &str,
        target: &Option<String>,
    ) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let id = self.add_node(label.to_owned(), kind, statement);
        self.connect(&incoming, &id);
        if let Some(target) = target {
            self.add_edge(&id, target, "");
        }
        Vec::new()
    }

    fn process_if(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let condition = statement.child_by_field_name("condition");
        let decision = self.add_node(
            condition
                .map(|node| clean_text(self.source, node))
                .unwrap_or_else(|| "condition".to_owned()),
            "decision",
            statement,
        );
        if let Some(condition) = condition {
            self.set_header(&decision, condition);
        }
        self.connect(&incoming, &decision);
        let then_exits = statement
            .child_by_field_name("consequence")
            .map(|body| {
                self.process_statement(
                    body,
                    vec![Exit {
                        node: decision.clone(),
                        label: "Yes".to_owned(),
                    }],
                    context,
                )
            })
            .unwrap_or_default();
        let else_exits = statement
            .child_by_field_name("alternative")
            .map(|body| {
                self.process_statement(
                    body,
                    vec![Exit {
                        node: decision.clone(),
                        label: "No".to_owned(),
                    }],
                    context,
                )
            })
            .unwrap_or_else(|| {
                vec![Exit {
                    node: decision,
                    label: "No".to_owned(),
                }]
            });
        let mut exits = then_exits;
        exits.extend(else_exits);
        self.merge_exits(exits, statement)
    }

    fn process_loop(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        _context: &ControlContext,
    ) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let foreach = statement.kind() == "foreach_statement";
        let condition = statement.child_by_field_name("condition");
        let label = if foreach {
            format!("foreach ({})", foreach_header(self.source, statement))
        } else if statement.kind() == "for_statement" {
            header_before_body(self.source, statement)
        } else {
            condition
                .map(|node| clean_text(self.source, node))
                .unwrap_or_else(|| "loop".to_owned())
        };
        let loop_node = self.add_node(label, "loop", statement);
        if let Some(header) = condition.or_else(|| statement.child_by_field_name("left")) {
            self.set_header(&loop_node, header);
        }
        self.set_loop_condition(&loop_node, if foreach { None } else { condition });
        self.connect(&incoming, &loop_node);
        let after = self.add_node_at(
            "Continue".to_owned(),
            "merge",
            statement.end_position().row + 1,
            statement.end_byte(),
            statement.end_byte(),
        );
        if foreach || condition.is_some() {
            self.add_edge(&loop_node, &after, if foreach { "Finished" } else { "No" });
        }
        let loop_context = ControlContext {
            break_target: Some(after.clone()),
            continue_target: Some(loop_node.clone()),
        };
        if let Some(body) = statement.child_by_field_name("body") {
            let exits = self.process_statement(
                body,
                vec![Exit {
                    node: loop_node.clone(),
                    label: if foreach { "Next item" } else { "Yes" }.to_owned(),
                }],
                &loop_context,
            );
            for exit in exits {
                self.add_edge(&exit.node, &loop_node, "Repeat");
            }
        } else {
            self.add_edge(&loop_node, &loop_node, "Repeat");
        }
        vec![Exit {
            node: after,
            label: String::new(),
        }]
    }

    fn process_do_loop(&mut self, statement: Node<'_>, incoming: Vec<Exit>) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let body = statement.child_by_field_name("body");
        let condition_node = statement.child_by_field_name("condition");
        let condition = self.add_node(
            condition_node
                .map(|node| format!("do while {}", clean_text(self.source, node)))
                .unwrap_or_else(|| "do while".to_owned()),
            "loop",
            statement,
        );
        if let Some(node) = condition_node {
            self.set_header(&condition, node);
        }
        self.set_loop_condition(&condition, condition_node);
        let after = self.add_node_at(
            "Continue".to_owned(),
            "merge",
            statement.end_position().row + 1,
            statement.end_byte(),
            statement.end_byte(),
        );
        let location = body.unwrap_or(statement);
        let entry = self.add_node_at(
            "Do".to_owned(),
            "merge",
            location.start_position().row + 1,
            location.start_byte(),
            location.start_byte(),
        );
        self.connect(&incoming, &entry);
        let context = ControlContext {
            break_target: Some(after.clone()),
            continue_target: Some(condition.clone()),
        };
        let exits = body
            .map(|body| {
                self.process_statement(
                    body,
                    vec![Exit {
                        node: entry.clone(),
                        label: String::new(),
                    }],
                    &context,
                )
            })
            .unwrap_or_else(|| {
                vec![Exit {
                    node: entry.clone(),
                    label: String::new(),
                }]
            });
        self.connect(&exits, &condition);
        self.add_edge(&condition, &entry, "Yes");
        self.add_edge(&condition, &after, "No");
        vec![Exit {
            node: after,
            label: String::new(),
        }]
    }

    fn process_switch(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let value = statement.child_by_field_name("value");
        let decision = self.add_node(
            value
                .map(|node| clean_text(self.source, node))
                .unwrap_or_else(|| "switch".to_owned()),
            "decision",
            statement,
        );
        if let Some(value) = value {
            self.set_header(&decision, value);
        }
        self.connect(&incoming, &decision);
        let after = self.add_node_at(
            "Continue".to_owned(),
            "merge",
            statement.end_position().row + 1,
            statement.end_byte(),
            statement.end_byte(),
        );
        let sections = statement
            .child_by_field_name("body")
            .map(named_children)
            .unwrap_or_default()
            .into_iter()
            .filter(|node| node.kind() == "switch_section")
            .collect::<Vec<_>>();
        if sections.is_empty() {
            self.add_edge(&decision, &after, "Default");
            return vec![Exit {
                node: after,
                label: String::new(),
            }];
        }
        let switch_context = ControlContext {
            break_target: Some(after.clone()),
            continue_target: context.continue_target.clone(),
        };
        let mut has_default = false;
        for section in sections {
            let labels = switch_labels(self.source, section);
            has_default |= labels.iter().any(|label| label == "default");
            let entry_label = labels.first().cloned().unwrap_or_else(|| "case".to_owned());
            let entry = self.add_node(entry_label, "merge", section);
            for label in labels {
                self.add_edge(&decision, &entry, &label);
            }
            let statements = named_children(section)
                .into_iter()
                .filter(|child| is_statement(child.kind()))
                .collect::<Vec<_>>();
            let exits = self.process_sequence(
                statements,
                vec![Exit {
                    node: entry,
                    label: String::new(),
                }],
                &switch_context,
            );
            self.connect(&exits, &after);
        }
        if !has_default {
            self.add_edge(&decision, &after, "No match");
        }
        vec![Exit {
            node: after,
            label: String::new(),
        }]
    }

    fn merge_exits(&mut self, exits: Vec<Exit>, location: Node<'_>) -> Vec<Exit> {
        if exits.is_empty() {
            return Vec::new();
        }
        if exits.len() == 1 && exits[0].label.is_empty() {
            return exits;
        }
        let merge = self.add_node_at(
            "Continue".to_owned(),
            "merge",
            location.end_position().row + 1,
            location.end_byte(),
            location.end_byte(),
        );
        self.connect(&exits, &merge);
        vec![Exit {
            node: merge,
            label: String::new(),
        }]
    }
}

pub fn inspect(source: String) -> Vec<FunctionInfo> {
    let Ok(tree) = parse(&source) else {
        return Vec::new();
    };
    definitions(&source, tree.root_node())
        .into_iter()
        .map(|definition| definition.info)
        .collect()
}

pub fn references(source: String) -> Vec<FunctionReference> {
    let Ok(tree) = parse(&source) else {
        return Vec::new();
    };
    let definitions = definitions(&source, tree.root_node());
    let mut references = Vec::new();
    for caller in &definitions {
        let mut calls = Vec::new();
        if caller.top_level {
            for global in named_children(caller.body)
                .into_iter()
                .filter(|node| node.kind() == "global_statement")
            {
                collect_invocations(global, &mut calls);
            }
        } else {
            collect_invocations(caller.body, &mut calls);
        }
        for call in calls {
            let Some(label) = static_call_name(&source, call) else {
                continue;
            };
            let candidates = matching_definitions(&source, caller, &definitions, &label);
            let Some(target) = (candidates.len() == 1)
                .then(|| candidates.first().copied())
                .flatten()
            else {
                continue;
            };
            let reference = FunctionReference {
                source: caller.info.id.clone(),
                target: target.info.id.clone(),
                label,
                start_byte: Some(call.start_byte()),
                end_byte: Some(call.end_byte()),
            };
            if !references.contains(&reference) {
                references.push(reference);
            }
        }
    }
    references
}

pub fn analyze(
    source: String,
    function_id: String,
    include_comments: bool,
) -> Result<FlowGraph, String> {
    let tree = parse(&source)?;
    let definitions = definitions(&source, tree.root_node());
    let definition = definitions
        .iter()
        .find(|definition| definition.info.id == function_id)
        .ok_or_else(|| format!("Function not found: {function_id}"))?;
    if let Some((line, construct)) = find_unsupported(definition.body, true, definition.top_level) {
        return Err(format!(
            "Unsupported control flow at line {line}: {construct} is not modeled"
        ));
    }

    let mut builder = GraphBuilder::new(&source, tree.root_node());
    let start = builder.add_node_at(
        definition.info.name.clone(),
        "start",
        definition.info.line,
        definition.node.start_byte(),
        definition.body.start_byte(),
    );
    let incoming = vec![Exit {
        node: start,
        label: String::new(),
    }];
    let exits = if definition.top_level {
        let globals = named_children(definition.body)
            .into_iter()
            .filter(|node| node.kind() == "global_statement")
            .collect::<Vec<_>>();
        builder.process_sequence(globals, incoming, &ControlContext::default())
    } else if definition.body.kind() == "arrow_expression_clause" {
        builder.process_arrow_body(definition, incoming)
    } else {
        builder.process_statement(definition.body, incoming, &ControlContext::default())
    };
    let end = builder.add_node_at(
        "End".to_owned(),
        "end",
        definition.body.end_position().row + 1,
        definition.body.end_byte(),
        definition.body.end_byte(),
    );
    builder.connect(&exits, &end);
    if include_comments {
        attach_comments(
            &source,
            definition.body,
            definition.top_level,
            &mut builder.nodes,
        );
    }
    Ok(FlowGraph {
        nodes: builder.nodes,
        edges: builder.edges,
        diagnostics: diagnostics(&tree),
    })
}

impl GraphBuilder<'_, '_> {
    fn process_arrow_body(
        &mut self,
        definition: &Definition<'_>,
        incoming: Vec<Exit>,
    ) -> Vec<Exit> {
        let expression = first_named_child(definition.body).unwrap_or(definition.body);
        let returns_void = definition
            .node
            .child_by_field_name("returns")
            .or_else(|| definition.node.child_by_field_name("type"))
            .is_some_and(|returns| node_text(self.source, returns).trim() == "void");
        let constructor = definition.node.kind() == "constructor_declaration";
        if returns_void || constructor {
            self.process_simple(vec![expression], incoming)
        } else {
            if incoming.is_empty() {
                return Vec::new();
            }
            let label = format!("return {}", clean_text(self.source, expression));
            let id = self.add_node(label, "return", expression);
            self.connect(&incoming, &id);
            Vec::new()
        }
    }
}

fn parse(source: &str) -> Result<Tree, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .map_err(|error| format!("Could not load C# parser: {error}"))?;
    parser
        .parse(source, None)
        .ok_or_else(|| "Could not parse C# source".to_owned())
}

fn definitions<'tree>(source: &str, root: Node<'tree>) -> Vec<Definition<'tree>> {
    let mut nodes = Vec::new();
    collect_definition_nodes(root, &mut nodes);
    let mut result = nodes
        .into_iter()
        .filter_map(|node| definition(source, node))
        .collect::<Vec<_>>();
    let globals = named_children(root)
        .into_iter()
        .filter(|node| node.kind() == "global_statement")
        .collect::<Vec<_>>();
    if let Some(first) = globals.first() {
        let top_level_tokens = globals
            .iter()
            .map(|global| canonical_tokens(source, *global))
            .collect::<Vec<_>>()
            .join("\0");
        result.insert(
            0,
            Definition {
                node: root,
                body: root,
                info: FunctionInfo {
                    id: "cs:top".to_owned(),
                    identity: format!(
                        "function-{}",
                        stable_fingerprint(&format!("top-level\0{top_level_tokens}"))
                    ),
                    name: "top-level".to_owned(),
                    qualified_name: "Program.Main".to_owned(),
                    line: first.start_position().row + 1,
                },
                unqualified_name: "Main".to_owned(),
                containing_type: Some("Program".to_owned()),
                static_member: true,
                top_level: true,
            },
        );
    }
    result
}

fn definition<'tree>(source: &str, node: Node<'tree>) -> Option<Definition<'tree>> {
    let body = node.child_by_field_name("body")?;
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(source, name_node).trim().to_owned();
    let mut scope = lexical_scope(source, node);
    scope.push(name.clone());
    let qualified_name = scope.join(".");
    let parameters = node
        .child_by_field_name("parameters")
        .map(|parameters| canonical_tokens(source, parameters))
        .unwrap_or_default();
    let identity = format!(
        "function-{}",
        stable_fingerprint(&format!(
            "qualified\0{qualified_name}\0parameters\0{parameters}"
        ))
    );
    let containing_type = containing_type(source, node);
    let static_member = named_children(node)
        .into_iter()
        .any(|child| child.kind() == "modifier" && node_text(source, child).trim() == "static");
    Some(Definition {
        node,
        body,
        info: FunctionInfo {
            id: format!("cs:{}", node.start_byte()),
            identity,
            name: name.clone(),
            qualified_name,
            line: node.start_position().row + 1,
        },
        unqualified_name: name,
        containing_type,
        static_member,
        top_level: false,
    })
}

fn collect_definition_nodes<'tree>(node: Node<'tree>, output: &mut Vec<Node<'tree>>) {
    if matches!(
        node.kind(),
        "method_declaration" | "constructor_declaration" | "local_function_statement"
    ) && node.child_by_field_name("body").is_some()
    {
        output.push(node);
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_definition_nodes(child, output);
    }
}

fn lexical_scope(source: &str, node: Node<'_>) -> Vec<String> {
    let mut scope = Vec::new();
    let mut parent = node.parent();
    while let Some(current) = parent {
        if matches!(
            current.kind(),
            "namespace_declaration"
                | "file_scoped_namespace_declaration"
                | "class_declaration"
                | "struct_declaration"
                | "record_declaration"
                | "interface_declaration"
                | "method_declaration"
                | "constructor_declaration"
                | "local_function_statement"
        ) {
            if let Some(name) = current.child_by_field_name("name") {
                let name = node_text(source, name).trim();
                if !name.is_empty() {
                    scope.push(name.to_owned());
                }
            }
        }
        parent = current.parent();
    }
    scope.reverse();
    scope
}

fn containing_type(source: &str, node: Node<'_>) -> Option<String> {
    let mut parts = Vec::new();
    let mut parent = node.parent();
    while let Some(current) = parent {
        if matches!(
            current.kind(),
            "namespace_declaration"
                | "file_scoped_namespace_declaration"
                | "class_declaration"
                | "struct_declaration"
                | "record_declaration"
                | "interface_declaration"
        ) {
            if let Some(name) = current.child_by_field_name("name") {
                let name = node_text(source, name).trim();
                if !name.is_empty() {
                    parts.push(name.to_owned());
                }
            }
        }
        parent = current.parent();
    }
    parts.reverse();
    (!parts.is_empty()).then(|| parts.join("."))
}

fn collect_invocations<'tree>(node: Node<'tree>, calls: &mut Vec<Node<'tree>>) {
    if node.kind() == "invocation_expression" {
        calls.push(node);
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if matches!(
            child.kind(),
            "method_declaration"
                | "constructor_declaration"
                | "local_function_statement"
                | "lambda_expression"
                | "anonymous_method_expression"
        ) {
            continue;
        }
        collect_invocations(child, calls);
    }
}

fn static_call_name(source: &str, call: Node<'_>) -> Option<String> {
    let function = call.child_by_field_name("function")?;
    if !matches!(
        function.kind(),
        "identifier" | "generic_name" | "member_access_expression" | "qualified_name"
    ) {
        return None;
    }
    let label = compact_call_name(&text_without_comments(source, function));
    (!label.is_empty()).then_some(label)
}

fn compact_call_name(value: &str) -> String {
    let compact = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let mut output = String::new();
    let mut generic_depth = 0usize;
    for character in compact.chars() {
        match character {
            '<' => generic_depth += 1,
            '>' if generic_depth > 0 => generic_depth -= 1,
            _ if generic_depth == 0 => output.push(character),
            _ => {}
        }
    }
    output
}

// Identify the standard Console API conservatively; custom Console types/values
// retain ordinary process symbols because their behavior is not known here.
fn custom_console(source: &str, node: Node<'_>) -> bool {
    if matches!(
        node.kind(),
        "class_declaration" | "struct_declaration" | "record_declaration" | "interface_declaration"
    ) && node
        .child_by_field_name("name")
        .is_some_and(|name| node_text(source, name).trim() == "Console")
    {
        return true;
    }
    let mut cursor = node.walk();
    let found = node
        .named_children(&mut cursor)
        .any(|child| custom_console(source, child));
    found
}

fn is_console_io(source: &str, console_is_standard: bool, statement: Node<'_>) -> bool {
    if !console_is_standard {
        return false;
    }
    let mut calls = Vec::new();
    collect_invocations(statement, &mut calls);
    calls.into_iter().any(|call| {
        static_call_name(source, call).is_some_and(|name| {
            matches!(
                name.as_str(),
                "Console.Write"
                    | "Console.WriteLine"
                    | "Console.Read"
                    | "Console.ReadLine"
                    | "Console.ReadKey"
                    | "System.Console.Write"
                    | "System.Console.WriteLine"
                    | "System.Console.Read"
                    | "System.Console.ReadLine"
                    | "System.Console.ReadKey"
            )
        })
    })
}

// A local value or delegate shadows a type/method name in expression context.
// Without compiler binding, omit the reference rather than guess a static target.
fn has_value_binding(source: &str, node: Node<'_>, name: &str) -> bool {
    if matches!(
        node.kind(),
        "variable_declarator" | "parameter" | "using_directive" | "declaration_expression"
    ) {
        if node
            .child_by_field_name("name")
            .is_some_and(|binding| node_text(source, binding).trim() == name)
        {
            return true;
        }
    }
    if node.kind() == "foreach_statement" {
        if node
            .child_by_field_name("left")
            .is_some_and(|binding| node_text(source, binding).trim() == name)
        {
            return true;
        }
    }
    let mut cursor = node.walk();
    let found = node
        .named_children(&mut cursor)
        .any(|child| has_value_binding(source, child, name));
    found
}

fn matching_definitions<'a, 'tree>(
    source: &str,
    caller: &Definition<'tree>,
    definitions: &'a [Definition<'tree>],
    label: &str,
) -> Vec<&'a Definition<'tree>> {
    let receiver = label.split('.').next().unwrap_or(label);
    if has_value_binding(source, caller.node, receiver) {
        return Vec::new();
    }
    if label.contains('.') {
        let Some((receiver, method)) = label.rsplit_once('.') else {
            return Vec::new();
        };
        return definitions
            .iter()
            .filter(|candidate| {
                candidate.static_member
                    && candidate.unqualified_name == method
                    && candidate
                        .containing_type
                        .as_ref()
                        .is_some_and(|containing_type| {
                            containing_type == receiver
                                || containing_type.ends_with(&format!(".{receiver}"))
                        })
            })
            .collect();
    }
    let caller_scope = caller
        .info
        .qualified_name
        .rsplit_once('.')
        .map(|(scope, _)| scope);
    if let Some(scope) = caller_scope {
        let exact = definitions
            .iter()
            .filter(|candidate| candidate.info.qualified_name == format!("{scope}.{label}"))
            .collect::<Vec<_>>();
        if !exact.is_empty() {
            return exact;
        }
    }
    definitions
        .iter()
        .filter(|candidate| candidate.unqualified_name == label)
        .collect()
}

fn find_unsupported(node: Node<'_>, root: bool, top_level: bool) -> Option<(usize, &'static str)> {
    if !root
        && matches!(
            node.kind(),
            "method_declaration"
                | "constructor_declaration"
                | "local_function_statement"
                | "lambda_expression"
                | "anonymous_method_expression"
        )
    {
        return None;
    }
    if top_level && !root && is_type_or_namespace_declaration(node.kind()) {
        return None;
    }
    let construct = match node.kind() {
        "try_statement" => Some("try/catch"),
        "goto_statement" | "labeled_statement" => Some("goto or labeled statements"),
        "await_expression" => Some("await"),
        "yield_statement" => Some("yield"),
        "lock_statement" => Some("lock"),
        "using_statement" => Some("using statement"),
        "fixed_statement" => Some("fixed statement"),
        "unsafe_statement" => Some("unsafe statement"),
        "switch_expression" => Some("switch expression"),
        "conditional_expression" => Some("conditional expression"),
        "throw_expression" => Some("throw expression"),
        "foreach_statement" if has_direct_child(node, "await") => Some("await foreach"),
        "checked_statement" => Some("checked statement"),
        "preproc_if" | "preproc_elif" | "preproc_else" => Some("conditional compilation"),
        _ => None,
    };
    if let Some(construct) = construct {
        return Some((node.start_position().row + 1, construct));
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(result) = find_unsupported(child, false, top_level) {
            return Some(result);
        }
    }
    None
}

fn is_type_or_namespace_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "namespace_declaration"
            | "file_scoped_namespace_declaration"
            | "class_declaration"
            | "struct_declaration"
            | "record_declaration"
            | "interface_declaration"
            | "enum_declaration"
    )
}

fn is_statement(kind: &str) -> bool {
    kind.ends_with("_statement")
        || matches!(
            kind,
            "block" | "if_statement" | "switch_statement" | "local_declaration_statement"
        )
}

fn is_simple(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "expression_statement" | "local_declaration_statement" | "empty_statement"
    )
}

fn switch_labels(source: &str, section: Node<'_>) -> Vec<String> {
    let children = {
        let mut cursor = section.walk();
        section.children(&mut cursor).collect::<Vec<_>>()
    };
    let mut labels = Vec::new();
    let mut index = 0;
    while index < children.len() {
        if !matches!(children[index].kind(), "case" | "default") {
            index += 1;
            continue;
        }
        let start = children[index].start_byte();
        let mut colon = None;
        index += 1;
        while index < children.len() {
            if children[index].kind() == ":" {
                colon = Some(children[index].end_byte());
                index += 1;
                break;
            }
            index += 1;
        }
        if let Some(end) = colon {
            let label = normalize(&text_range_without_comments(
                source,
                section,
                start,
                end.saturating_sub(1),
            ));
            if !label.is_empty() {
                labels.push(label);
            }
        }
    }
    labels
}

fn foreach_header(source: &str, statement: Node<'_>) -> String {
    let left = statement
        .child_by_field_name("left")
        .map(|node| clean_text(source, node))
        .unwrap_or_else(|| "item".to_owned());
    let right = statement
        .child_by_field_name("right")
        .map(|node| clean_text(source, node))
        .unwrap_or_else(|| "items".to_owned());
    let item_type = statement
        .child_by_field_name("type")
        .map(|node| format!("{} ", clean_text(source, node)))
        .unwrap_or_default();
    format!("{item_type}{left} in {right}")
}

fn header_before_body(source: &str, statement: Node<'_>) -> String {
    let end = statement
        .child_by_field_name("body")
        .map(|body| body.start_byte())
        .unwrap_or_else(|| statement.end_byte());
    normalize(&text_range_without_comments(
        source,
        statement,
        statement.start_byte(),
        end,
    ))
}

fn node_text<'a>(source: &'a str, node: Node<'_>) -> &'a str {
    source.get(node.byte_range()).unwrap_or_default()
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn first_named_child(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    let child = node.named_children(&mut cursor).next();
    child
}

fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_statement(value: &str) -> String {
    normalize(value).trim_end_matches(';').trim().to_owned()
}

fn clean_text(source: &str, node: Node<'_>) -> String {
    normalize(&text_without_comments(source, node))
}

fn text_without_comments(source: &str, node: Node<'_>) -> String {
    text_range_without_comments(source, node, node.start_byte(), node.end_byte())
}

fn text_range_without_comments(
    source: &str,
    node: Node<'_>,
    start_byte: usize,
    end_byte: usize,
) -> String {
    let mut comments = Vec::new();
    collect_kind(node, "comment", &mut |comment| {
        if comment.start_byte() < end_byte && comment.end_byte() > start_byte {
            comments.push((
                comment.start_byte().max(start_byte),
                comment.end_byte().min(end_byte),
            ));
        }
    });
    comments.sort_unstable_by_key(|range| range.0);
    let mut output = String::new();
    let mut cursor = start_byte;
    for (comment_start, comment_end) in comments {
        if comment_start > cursor {
            output.push_str(source.get(cursor..comment_start).unwrap_or_default());
        }
        output.push(' ');
        cursor = cursor.max(comment_end);
    }
    if cursor < end_byte {
        output.push_str(source.get(cursor..end_byte).unwrap_or_default());
    }
    output
}

fn source_identity(
    source: &str,
    root: Node<'_>,
    kind: &str,
    start_byte: usize,
    end_byte: usize,
) -> String {
    format!(
        "node-{}",
        stable_fingerprint(&format!(
            "{kind}\0{}",
            canonical_range(source, root, start_byte, end_byte)
        ))
    )
}

fn canonical_tokens(source: &str, node: Node<'_>) -> String {
    canonical_range(source, node, node.start_byte(), node.end_byte())
}

fn canonical_range(source: &str, node: Node<'_>, start: usize, end: usize) -> String {
    fn append(source: &str, node: Node<'_>, start: usize, end: usize, output: &mut String) {
        if node.kind() == "comment" || node.end_byte() <= start || node.start_byte() >= end {
            return;
        }
        if node.child_count() == 0 {
            if node.start_byte() >= start && node.end_byte() <= end {
                let text = node_text(source, node);
                output.push_str(&node.kind().len().to_string());
                output.push(':');
                output.push_str(node.kind());
                output.push(':');
                output.push_str(&text.len().to_string());
                output.push(':');
                output.push_str(text);
                output.push(';');
            }
            return;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            append(source, child, start, end, output);
        }
    }
    let mut output = String::new();
    append(source, node, start, end, &mut output);
    output
}

fn stable_fingerprint(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn collect_kind(node: Node<'_>, kind: &str, callback: &mut impl FnMut(Node<'_>)) {
    if node.kind() == kind {
        callback(node);
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_kind(child, kind, callback);
    }
}

fn attach_comments(source: &str, body: Node<'_>, top_level: bool, nodes: &mut [FlowNode]) {
    let mut comments = Vec::new();
    collect_scoped_comments(source, body, top_level, &mut comments);
    for (start, end, text) in comments {
        if text.is_empty() {
            continue;
        }
        if let Some(target) = nodes.iter_mut().min_by_key(|node| {
            if start >= node.start_byte && end <= node.end_byte {
                0
            } else if end <= node.start_byte {
                node.start_byte - end
            } else {
                start.saturating_sub(node.end_byte)
            }
        }) {
            target.comments.push(text);
        }
    }
}

fn collect_scoped_comments(
    source: &str,
    node: Node<'_>,
    top_level: bool,
    comments: &mut Vec<(usize, usize, String)>,
) {
    if node.kind() == "comment" {
        comments.push((
            node.start_byte(),
            node.end_byte(),
            normalize(node_text(source, node)),
        ));
        return;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if matches!(
            child.kind(),
            "method_declaration"
                | "constructor_declaration"
                | "local_function_statement"
                | "lambda_expression"
                | "anonymous_method_expression"
        ) || top_level && is_type_or_namespace_declaration(child.kind())
        {
            continue;
        }
        collect_scoped_comments(source, child, top_level, comments);
    }
}

fn has_direct_child(node: Node<'_>, kind: &str) -> bool {
    let mut cursor = node.walk();
    let result = node.children(&mut cursor).any(|child| child.kind() == kind);
    result
}

fn diagnostics(tree: &Tree) -> Vec<String> {
    let mut output = Vec::new();
    collect_diagnostics(tree.root_node(), &mut output);
    output
}

fn collect_diagnostics(node: Node<'_>, output: &mut Vec<String>) {
    if node.is_error() || node.is_missing() {
        output.push(format!(
            "{} at line {}, column {}",
            if node.is_missing() {
                format!("Missing {}", node.kind())
            } else {
                "Syntax error".to_owned()
            },
            node.start_position().row + 1,
            node.start_position().column + 1
        ));
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_diagnostics(child, output);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        r#"
class Routes {
    Routes() { Initialize(); }
    void Initialize() { }
    int Route(int value) {
        // normalize
        foreach (var item in Items) {
            if (item > value) continue;
            value += item;
        }
        while (value < 10) value++;
        return value;
    }
}
"#
        .to_owned()
    }

    #[test]
    fn inspects_methods_constructors_local_functions_and_top_level() {
        let source = format!(
            "{}\nint Local(int value) => value + 1;\nConsole.WriteLine(Local(1));",
            sample()
        );
        let functions = inspect(source);
        assert!(functions
            .iter()
            .all(|function| function.id.starts_with("cs:")));
        assert!(functions.iter().any(|function| function.id == "cs:top"));
        assert!(functions
            .iter()
            .any(|function| function.qualified_name == "Routes.Routes"));
        assert!(functions
            .iter()
            .any(|function| function.qualified_name == "Routes.Route"));
        assert!(functions.iter().any(|function| function.name == "Local"));
    }

    #[test]
    fn analyzes_foreach_while_comments_and_terminal_return() {
        let source = sample();
        let id = inspect(source.clone())
            .into_iter()
            .find(|function| function.name == "Route")
            .unwrap()
            .id;
        let graph = analyze(source, id, true).unwrap();
        let foreach = graph
            .nodes
            .iter()
            .find(|node| node.kind == "loop" && node.label.starts_with("foreach"))
            .unwrap();
        assert_eq!(foreach.loop_condition, None);
        assert!(graph.edges.iter().any(|edge| edge.label == "Next item"));
        assert!(graph.edges.iter().any(|edge| edge.label == "Finished"));
        assert!(graph.nodes.iter().any(|node| node.kind == "continue"));
        assert!(graph.nodes.iter().any(|node| node.kind == "return"));
        assert!(graph.nodes.iter().any(|node| {
            node.comments
                .iter()
                .any(|comment| comment.contains("normalize"))
        }));
    }

    #[test]
    fn references_resolve_unique_calls_and_skip_overloads() {
        let source = r#"
class Work {
    void Unique() { }
    void Same(int value) { }
    void Same(string value) { }
    void Caller() { Unique(); Same(1); object.Run(); Helper.StaticRun(); helper.Run(); }
}
class Other { void Unique() { } }
class Helper { public static void StaticRun() { } }
class External { public void Run() { } }
"#
        .to_owned();
        let references = references(source);
        assert_eq!(references.len(), 2);
        assert!(references
            .iter()
            .any(|reference| reference.label == "Unique"));
        assert!(references
            .iter()
            .any(|reference| reference.label == "Helper.StaticRun"));
        assert!(!references
            .iter()
            .any(|reference| reference.label == "helper.Run"));
        assert!(references
            .iter()
            .all(|reference| reference.start_byte.is_some() && reference.end_byte.is_some()));
    }

    #[test]
    fn analyzes_if_for_do_switch_break_and_throw() {
        let source = r#"
class Control {
    int Run(int value) {
        for (var i = 0; i < 3; i++) {
            if (i == value) break;
            else continue;
        }
        do { value++; } while (value < 5);
        switch (value) {
            case 5: return value;
            default: throw new Exception();
        }
    }
}
"#
        .to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        for kind in ["decision", "loop", "break", "continue", "return", "throw"] {
            assert!(graph.nodes.iter().any(|node| node.kind == kind), "{kind}");
        }
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.label.starts_with("for ")));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.label.starts_with("do while")));
        assert!(graph.edges.iter().any(|edge| edge.label == "case 5"));
        assert!(graph.edges.iter().any(|edge| edge.label == "default"));
    }

    #[test]
    fn infinite_for_has_no_synthetic_false_exit() {
        let source = "class C { void Run() { for (;;) { Work(); } After(); } }".to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        let loop_node = graph.nodes.iter().find(|node| node.kind == "loop").unwrap();
        assert!(!graph
            .edges
            .iter()
            .any(|edge| edge.source == loop_node.id && edge.label == "No"));
    }

    #[test]
    fn switch_uses_tree_label_boundaries_for_colons_multiple_cases_and_guards() {
        let source = r#"
class C {
    int Run(string value) {
        switch (value) {
            case "a:b":
            case "c" when Ready(): return 1;
            default: return 0;
        }
    }
}
"#
        .to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        for label in ["case \"a:b\"", "case \"c\" when Ready()", "default"] {
            assert!(
                graph.edges.iter().any(|edge| edge.label == label),
                "{label}"
            );
        }
    }

    #[test]
    fn foreach_and_arrow_expression_labels_are_canonical() {
        let source = r#"
class C {
    int Twice(int value) => value * 2;
    void Log(int value) => Console.WriteLine(value);
    void Each() {
        void Local() => Tick();
        Local();
        foreach (int value in new[] { 1, 2, 3 }) Log(value);
    }
}
"#
        .to_owned();
        let functions = inspect(source.clone());
        let twice = functions
            .iter()
            .find(|function| function.name == "Twice")
            .unwrap();
        let twice_graph = analyze(source.clone(), twice.id.clone(), false).unwrap();
        assert!(twice_graph
            .nodes
            .iter()
            .any(|node| node.kind == "return" && node.label == "return value * 2"));
        let log = functions
            .iter()
            .find(|function| function.name == "Log")
            .unwrap();
        let log_graph = analyze(source.clone(), log.id.clone(), false).unwrap();
        assert!(log_graph
            .nodes
            .iter()
            .any(|node| { node.kind == "io" && node.label == "Console.WriteLine(value)" }));
        assert!(!log_graph.nodes.iter().any(|node| node.kind == "return"));
        let local = functions
            .iter()
            .find(|function| function.name == "Local")
            .unwrap();
        let local_graph = analyze(source.clone(), local.id.clone(), false).unwrap();
        assert!(local_graph
            .nodes
            .iter()
            .any(|node| node.kind == "process" && node.label == "Tick()"));
        assert!(!local_graph.nodes.iter().any(|node| node.kind == "return"));
        let each = functions
            .iter()
            .find(|function| function.name == "Each")
            .unwrap();
        let each_graph = analyze(source, each.id.clone(), false).unwrap();
        assert!(each_graph.nodes.iter().any(|node| {
            node.kind == "loop" && node.label == "foreach (int value in new[] { 1, 2, 3 })"
        }));
    }

    #[test]
    fn unsupported_control_flow_fails_closed() {
        for (source, construct) in [
            (
                "class C { void M() { try { A(); } catch { B(); } } }",
                "try/catch",
            ),
            ("class C { async void M() { await A(); } }", "await"),
            (
                "class C { IEnumerable<int> M() { yield return 1; } }",
                "yield",
            ),
            (
                "class C { void M() { checked { if (Ready()) Work(); } } }",
                "checked statement",
            ),
            (
                "class C { void M() {\n#if FLAG\nif (Ready()) Work();\n#endif\n} }",
                "conditional compilation",
            ),
        ] {
            let source = source.to_owned();
            let id = inspect(source.clone())[0].id.clone();
            let error = analyze(source, id, false).unwrap_err();
            assert!(error.contains(construct), "{error}");
            assert!(error.starts_with("Unsupported control flow at line "));
        }
    }
    #[test]
    fn references_skip_shadowed_static_types_and_delegates() {
        let source = r#"
class C {
    class helper { public static void Run() {} }
    void Unique() {}
    void Caller() {
        var helper = new External();
        helper.Run();
        Action Unique = () => {};
        Unique();
        C.helper.Run();
    }
}
class External { public void Run() {} }
"#
        .to_owned();
        let refs = references(source);
        assert!(!refs.iter().any(|reference| reference.label == "helper.Run"));
        assert!(!refs.iter().any(|reference| reference.label == "Unique"));
        assert!(refs
            .iter()
            .any(|reference| reference.label == "C.helper.Run"));
    }
    #[test]
    fn console_io_keeps_input_output_separate_from_processing() {
        let source = "class Demo { static void Main() { int value = 0; Console.WriteLine(value); value++; } }".to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        assert_eq!(
            graph
                .nodes
                .iter()
                .filter(|node| matches!(node.kind.as_str(), "process" | "io"))
                .map(|node| node.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["process", "io", "process"]
        );
        let commented =
            "class Demo { static void Main() { Console /* note */ . WriteLine(1); } }".to_owned();
        let id = inspect(commented.clone())[0].id.clone();
        assert!(analyze(commented, id, false)
            .unwrap()
            .nodes
            .iter()
            .any(|node| node.kind == "io"));
        let source = "class Console { public static void WriteLine(int n) {} } class Demo { void Main() { Console.WriteLine(1); } }".to_owned();
        let id = inspect(source.clone())
            .into_iter()
            .find(|method| method.name == "Main")
            .unwrap()
            .id;
        assert!(!analyze(source, id, false)
            .unwrap()
            .nodes
            .iter()
            .any(|node| node.kind == "io"));
    }
    #[test]
    fn console_aliases_and_interfaces_are_not_standard_io() {
        for source in [
            "using Console = CustomLogger; class Demo { static void Main() { Console.WriteLine(1); } }",
            "interface Console { static void WriteLine(int n) {} } class Demo { static void Main() { Console.WriteLine(1); } }",
            "class Demo { static void Main() { TryGet(out var Console); Console.WriteLine(1); } }",
        ] {
            let source = source.to_owned();
            let id = inspect(source.clone()).into_iter().find(|method| method.name == "Main").unwrap().id;
            let graph = analyze(source, id, false).unwrap();
            assert!(!graph.nodes.iter().any(|node| node.kind == "io"));
        }
    }
}
