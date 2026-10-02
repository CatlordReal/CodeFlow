use serde::Serialize;
use tree_sitter::{Node, Parser, Tree};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FunctionInfo {
    pub id: String,
    pub name: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FlowGraph {
    pub nodes: Vec<FlowNode>,
    pub edges: Vec<FlowEdge>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FlowNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub line: usize,
    pub start_byte: usize,
    pub end_byte: usize,
    pub comments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FlowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub label: String,
}

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

struct GraphBuilder<'a> {
    source: &'a str,
    nodes: Vec<FlowNode>,
    edges: Vec<FlowEdge>,
    next_node: usize,
    next_edge: usize,
}

impl<'a> GraphBuilder<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
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
            comments: Vec::new(),
        });
        id
    }

    fn connect(&mut self, exits: &[Exit], target: &str) {
        for exit in exits {
            self.add_edge(&exit.node, target, &exit.label);
        }
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

    fn process_statement(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        match statement.kind() {
            "comment" => incoming,
            "attributed_statement" => attributed_body(statement).map_or(incoming.clone(), |body| {
                self.process_statement(body, incoming, context)
            }),
            "compound_statement" => self.process_compound(statement, incoming, context),
            "if_statement" => self.process_if(statement, incoming, context),
            "while_statement" | "for_statement" | "for_range_loop" => {
                self.process_loop(statement, incoming, context)
            }
            "do_statement" => self.process_do_loop(statement, incoming, context),
            "switch_statement" => self.process_switch(statement, incoming, context),
            "return_statement" | "co_return_statement" => {
                self.process_terminal(statement, incoming, "return", "Return")
            }
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
            "case_statement" => self.process_case(statement, incoming, context),
            _ if is_throw_terminal(statement) => {
                self.process_terminal(statement, incoming, "throw", "Throw")
            }
            _ => self.process_simple(vec![statement], incoming),
        }
    }

    fn process_compound(
        &mut self,
        compound: Node<'_>,
        mut incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        let statements = named_children(compound);
        let mut simple = Vec::new();

        for statement in statements {
            if statement.kind() == "comment" {
                continue;
            }
            if is_simple(statement) {
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

    fn process_simple(&mut self, statements: Vec<Node<'_>>, incoming: Vec<Exit>) -> Vec<Exit> {
        if statements.is_empty() || incoming.is_empty() {
            return incoming;
        }

        let first = statements[0];
        let last = *statements.last().expect("non-empty statements");
        let label = statements
            .iter()
            .filter(|node| node.kind() != "comment")
            .map(|node| clean_statement(&text_without_comments(self.source, *node)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if label.is_empty() {
            return incoming;
        }

        let id = self.add_node_at(
            label,
            "process",
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
        let text = clean_statement(&text_without_comments(self.source, statement));
        let id = self.add_node(
            if text.is_empty() {
                fallback.to_owned()
            } else {
                text
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
        let condition = statement
            .child_by_field_name("condition")
            .map(|node| condition_text(self.source, node))
            .unwrap_or_else(|| "condition".to_owned());
        let decision = self.add_node(condition, "decision", statement);
        self.connect(&incoming, &decision);

        let then_statement = statement.child_by_field_name("consequence");
        let else_statement = statement
            .child_by_field_name("alternative")
            .and_then(unwrap_else_clause);
        let then_exits = then_statement.map_or_else(Vec::new, |body| {
            self.process_statement(
                body,
                vec![Exit {
                    node: decision.clone(),
                    label: "Yes".to_owned(),
                }],
                context,
            )
        });
        let else_exits = if let Some(body) = else_statement {
            self.process_statement(
                body,
                vec![Exit {
                    node: decision,
                    label: "No".to_owned(),
                }],
                context,
            )
        } else {
            vec![Exit {
                node: decision,
                label: "No".to_owned(),
            }]
        };

        let mut exits = then_exits;
        exits.extend(else_exits);
        self.merge_exits(exits, statement)
    }

    fn process_loop(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let label = loop_label(self.source, statement);
        let loop_node = self.add_node(label, "loop", statement);
        self.connect(&incoming, &loop_node);
        let after = self.add_node_at(
            "Continue".to_owned(),
            "merge",
            statement.end_position().row + 1,
            statement.end_byte(),
            statement.end_byte(),
        );
        self.add_edge(&loop_node, &after, "No");

        let body = statement.child_by_field_name("body");
        if let Some(body) = body {
            let loop_context = ControlContext {
                break_target: Some(after.clone()),
                continue_target: Some(loop_node.clone()),
            };
            let body_exits = self.process_statement(
                body,
                vec![Exit {
                    node: loop_node.clone(),
                    label: "Yes".to_owned(),
                }],
                &loop_context,
            );
            for exit in body_exits {
                self.add_edge(&exit.node, &loop_node, "Repeat");
            }
        } else {
            self.add_edge(&loop_node, &loop_node, "Repeat");
        }

        let _ = context;
        vec![Exit {
            node: after,
            label: String::new(),
        }]
    }

    fn process_do_loop(
        &mut self,
        statement: Node<'_>,
        incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        if incoming.is_empty() {
            return Vec::new();
        }
        let body = statement.child_by_field_name("body");
        let condition_location = statement
            .child_by_field_name("condition")
            .unwrap_or(statement);
        let condition = self.add_node(
            loop_label(self.source, statement),
            "loop",
            condition_location,
        );
        let after = self.add_node_at(
            "Continue".to_owned(),
            "merge",
            statement.end_position().row + 1,
            statement.end_byte(),
            statement.end_byte(),
        );
        let entry_location = body.unwrap_or(statement);
        let entry = self.add_node_at(
            "Do".to_owned(),
            "merge",
            entry_location.start_position().row + 1,
            entry_location.start_byte(),
            entry_location.start_byte(),
        );
        self.connect(&incoming, &entry);

        let loop_context = ControlContext {
            break_target: Some(after.clone()),
            continue_target: Some(condition.clone()),
        };
        let body_exits = body.map_or_else(
            || {
                vec![Exit {
                    node: entry.clone(),
                    label: String::new(),
                }]
            },
            |body| {
                self.process_statement(
                    body,
                    vec![Exit {
                        node: entry.clone(),
                        label: String::new(),
                    }],
                    &loop_context,
                )
            },
        );
        self.connect(&body_exits, &condition);
        self.add_edge(&condition, &entry, "Yes");
        self.add_edge(&condition, &after, "No");

        let _ = context;
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
        let condition = statement
            .child_by_field_name("condition")
            .map(|node| condition_text(self.source, node))
            .unwrap_or_else(|| "switch".to_owned());
        let decision = self.add_node(condition, "decision", statement);
        self.connect(&incoming, &decision);
        let after = self.add_node_at(
            "Continue".to_owned(),
            "merge",
            statement.end_position().row + 1,
            statement.end_byte(),
            statement.end_byte(),
        );

        let body = statement.child_by_field_name("body");
        let cases = body.map(case_children).unwrap_or_default();
        if cases.is_empty() {
            self.add_edge(&decision, &after, "Default");
        } else {
            let switch_context = ControlContext {
                break_target: Some(after.clone()),
                continue_target: context.continue_target.clone(),
            };
            let mut fallthrough: Vec<Exit> = Vec::new();
            let mut has_default = false;
            for case in cases {
                let case_label = case_label(self.source, case);
                has_default |= case.child_by_field_name("value").is_none();
                let header_end = case_header_end(self.source, case);
                let entry = self.add_node_at(
                    case_label.clone(),
                    "merge",
                    case.start_position().row + 1,
                    case.start_byte(),
                    header_end,
                );
                self.add_edge(&decision, &entry, &case_label);
                for exit in fallthrough {
                    self.add_edge(&exit.node, &entry, "Fallthrough");
                }
                fallthrough = self.process_case(
                    case,
                    vec![Exit {
                        node: entry,
                        label: String::new(),
                    }],
                    &switch_context,
                );
            }
            self.connect(&fallthrough, &after);
            if !has_default {
                self.add_edge(&decision, &after, "No match");
            }
        }
        vec![Exit {
            node: after,
            label: String::new(),
        }]
    }

    fn process_case(
        &mut self,
        case: Node<'_>,
        mut incoming: Vec<Exit>,
        context: &ControlContext,
    ) -> Vec<Exit> {
        let value_range = case
            .child_by_field_name("value")
            .map(|node| node.byte_range());
        let statements = named_children(case)
            .into_iter()
            .filter(|node| Some(node.byte_range()) != value_range && node.kind() != "comment")
            .collect::<Vec<_>>();
        let mut simple = Vec::new();
        for statement in statements {
            if is_simple(statement) {
                simple.push(statement);
            } else {
                if !simple.is_empty() {
                    incoming = self.process_simple(std::mem::take(&mut simple), incoming);
                }
                incoming = self.process_statement(statement, incoming, context);
            }
        }
        if !simple.is_empty() {
            incoming = self.process_simple(simple, incoming);
        }
        incoming
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
    let mut functions = Vec::new();
    collect_nodes(tree.root_node(), "function_definition", &mut |node| {
        let declarator = node.child_by_field_name("declarator");
        let name = declarator
            .and_then(|node| function_name(&source, node))
            .unwrap_or_else(|| "anonymous".to_owned());
        functions.push(FunctionInfo {
            id: node.start_byte().to_string(),
            name,
            line: node.start_position().row + 1,
        });
    });
    functions
}

pub fn analyze(
    source: String,
    function_id: String,
    include_comments: bool,
) -> Result<FlowGraph, String> {
    let tree = parse(&source)?;
    let start_byte = function_id
        .parse::<usize>()
        .map_err(|_| format!("Invalid function id: {function_id}"))?;
    let function = find_function(tree.root_node(), start_byte)
        .ok_or_else(|| format!("Function not found: {function_id}"))?;
    let body = function
        .child_by_field_name("body")
        .ok_or_else(|| "Function has no body".to_owned())?;
    if let Some((line, construct)) = find_unsupported_control(body, true) {
        return Err(format!(
            "Unsupported control flow at line {line}: {construct} is not modeled"
        ));
    }
    let name = function
        .child_by_field_name("declarator")
        .and_then(|node| function_name(&source, node))
        .unwrap_or_else(|| "Function".to_owned());

    let mut builder = GraphBuilder::new(&source);
    let start = builder.add_node_at(
        name,
        "start",
        function.start_position().row + 1,
        function.start_byte(),
        body.start_byte(),
    );
    let exits = builder.process_compound(
        body,
        vec![Exit {
            node: start,
            label: String::new(),
        }],
        &ControlContext::default(),
    );
    let end = builder.add_node_at(
        "End".to_owned(),
        "end",
        body.end_position().row + 1,
        body.end_byte(),
        body.end_byte(),
    );
    builder.connect(&exits, &end);

    if include_comments {
        attach_comments(&source, body, &mut builder.nodes);
    }

    Ok(FlowGraph {
        nodes: builder.nodes,
        edges: builder.edges,
        diagnostics: diagnostics(&tree),
    })
}

fn parse(source: &str) -> Result<Tree, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_cpp::LANGUAGE.into())
        .map_err(|error| format!("Could not load C++ parser: {error}"))?;
    parser
        .parse(source, None)
        .ok_or_else(|| "Could not parse C++ source".to_owned())
}

fn function_name(source: &str, declarator: Node<'_>) -> Option<String> {
    if matches!(
        declarator.kind(),
        "identifier"
            | "field_identifier"
            | "operator_name"
            | "destructor_name"
            | "qualified_identifier"
            | "template_function"
    ) {
        return Some(normalize(node_text(source, declarator)));
    }

    if let Some(inner) = declarator.child_by_field_name("declarator") {
        if let Some(name) = function_name(source, inner) {
            return Some(name);
        }
    }

    let mut cursor = declarator.walk();
    for child in declarator.named_children(&mut cursor) {
        if let Some(name) = function_name(source, child) {
            return Some(name);
        }
    }
    None
}

fn find_function(node: Node<'_>, start_byte: usize) -> Option<Node<'_>> {
    if node.kind() == "function_definition" && node.start_byte() == start_byte {
        return Some(node);
    }
    let mut cursor = node.walk();
    let result = node
        .named_children(&mut cursor)
        .find_map(|child| find_function(child, start_byte));
    result
}

fn named_children(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn unwrap_else_clause(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() != "else_clause" {
        return Some(node);
    }
    let mut cursor = node.walk();
    let result = node.named_children(&mut cursor).next();
    result
}

fn collect_nodes(node: Node<'_>, kind: &str, callback: &mut impl FnMut(Node<'_>)) {
    if node.kind() == kind {
        callback(node);
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_nodes(child, kind, callback);
    }
}

fn is_simple(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "expression_statement"
            | "declaration"
            | "using_declaration"
            | "type_definition"
            | "static_assert_declaration"
    ) && !is_throw_terminal(node)
}

fn is_throw_terminal(node: Node<'_>) -> bool {
    if matches!(node.kind(), "throw_statement" | "throw_expression") {
        return true;
    }
    if node.kind() != "expression_statement" {
        return false;
    }
    let mut cursor = node.walk();
    let expression = node.named_children(&mut cursor).next();
    expression.is_some_and(is_unwrapped_throw_expression)
}

fn is_unwrapped_throw_expression(node: Node<'_>) -> bool {
    if node.kind() == "throw_expression" {
        return true;
    }
    if node.kind() != "parenthesized_expression" {
        return false;
    }
    let mut cursor = node.walk();
    let mut children = node.named_children(&mut cursor);
    let first = children.next();
    first.is_some_and(is_unwrapped_throw_expression) && children.next().is_none()
}

fn attributed_body(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    let result = node
        .named_children(&mut cursor)
        .find(|child| child.kind() != "attribute_declaration");
    result
}

fn find_unsupported_control(node: Node<'_>, root: bool) -> Option<(usize, &'static str)> {
    if !root && matches!(node.kind(), "lambda_expression" | "function_definition") {
        return None;
    }
    let construct = match node.kind() {
        "try_statement" => Some("try/catch"),
        "goto_statement" => Some("goto"),
        "labeled_statement" => Some("labeled statements"),
        "seh_try_statement" | "seh_leave_statement" => {
            Some("Windows structured exception handling")
        }
        "preproc_if" | "preproc_ifdef" | "preproc_elif" | "preproc_elifdef" => {
            Some("preprocessor conditionals")
        }
        "gnu_asm_expression" => Some("inline assembly"),
        "co_yield_statement" | "co_await_expression" => Some("coroutine suspension"),
        _ => None,
    };
    if let Some(construct) = construct {
        return Some((node.start_position().row + 1, construct));
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(unsupported) = find_unsupported_control(child, false) {
            return Some(unsupported);
        }
    }
    None
}

fn node_text<'a>(source: &'a str, node: Node<'_>) -> &'a str {
    source.get(node.byte_range()).unwrap_or_default()
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_statement(text: &str) -> String {
    normalize(text).trim_end_matches(';').trim().to_owned()
}

fn condition_text(source: &str, node: Node<'_>) -> String {
    let text = normalize(&text_without_comments(source, node));
    text.strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .unwrap_or(&text)
        .trim()
        .to_owned()
}

fn loop_label(source: &str, statement: Node<'_>) -> String {
    match statement.kind() {
        "do_statement" => statement
            .child_by_field_name("condition")
            .map(|node| format!("do while {}", condition_text(source, node)))
            .unwrap_or_else(|| "do while".to_owned()),
        "for_range_loop" => header_before_body(source, statement),
        "for_statement" => header_before_body(source, statement),
        _ => statement
            .child_by_field_name("condition")
            .map(|node| condition_text(source, node))
            .unwrap_or_else(|| header_before_body(source, statement)),
    }
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

fn case_children<'tree>(body: Node<'tree>) -> Vec<Node<'tree>> {
    let mut cases = Vec::new();
    collect_case_nodes(body, &mut cases);
    cases
}

fn collect_case_nodes<'tree>(node: Node<'tree>, cases: &mut Vec<Node<'tree>>) {
    if node.kind() == "case_statement" {
        cases.push(node);
        return;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_case_nodes(child, cases);
    }
}

fn case_label(source: &str, case: Node<'_>) -> String {
    let text = text_without_comments(source, case);
    let header = text.split(':').next().unwrap_or("case");
    normalize(header)
}

fn case_header_end(source: &str, case: Node<'_>) -> usize {
    source
        .get(case.byte_range())
        .and_then(|text| text.find(':'))
        .map(|offset| case.start_byte() + offset + 1)
        .unwrap_or_else(|| {
            case.child_by_field_name("value")
                .map(|value| value.end_byte())
                .unwrap_or_else(|| case.start_byte())
        })
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
    collect_nodes(node, "comment", &mut |comment| {
        if comment.start_byte() < end_byte && comment.end_byte() > start_byte {
            comments.push((
                comment.start_byte().max(start_byte),
                comment.end_byte().min(end_byte),
            ));
        }
    });
    comments.sort_unstable_by_key(|range| range.0);

    let mut text = String::new();
    let mut cursor = start_byte;
    for (comment_start, comment_end) in comments {
        if comment_start > cursor {
            text.push_str(source.get(cursor..comment_start).unwrap_or_default());
        }
        text.push(' ');
        cursor = cursor.max(comment_end);
    }
    if cursor < end_byte {
        text.push_str(source.get(cursor..end_byte).unwrap_or_default());
    }
    text
}

fn attach_comments(source: &str, body: Node<'_>, nodes: &mut [FlowNode]) {
    let mut comments = Vec::new();
    collect_nodes(body, "comment", &mut |node| {
        comments.push((
            node.start_byte(),
            node.end_byte(),
            normalize(node_text(source, node)),
        ));
    });

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

fn diagnostics(tree: &Tree) -> Vec<String> {
    let mut result = Vec::new();
    collect_parse_diagnostics(tree.root_node(), &mut result);
    result
}

fn collect_parse_diagnostics(node: Node<'_>, diagnostics: &mut Vec<String>) {
    if node.is_error() || node.is_missing() {
        diagnostics.push(format!(
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
        collect_parse_diagnostics(child, diagnostics);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        r#"
// helper
int helper() { return 1; }

int route(int value) {
    // Normalize input.
    int adjusted = value + 1;
    adjusted *= 2;

    if (
        adjusted > 10 &&
        value != 4
    )
        return adjusted;
    else if (adjusted == 6) {
        throw std::runtime_error("six");
    }

    for (int i = 0; i < adjusted; ++i) {
        if (i == 2) continue;
        if (i == 8) break;
        adjusted += i;
    }
    return adjusted;
}
"#
        .to_owned()
    }

    #[test]
    fn inspects_functions_with_stable_byte_ids() {
        let source = sample();
        let functions = inspect(source.clone());
        assert_eq!(functions.len(), 2);
        assert_eq!(functions[0].name, "helper");
        assert_eq!(functions[1].name, "route");
        let offset = functions[1].id.parse::<usize>().unwrap();
        assert_eq!(&source[offset..offset + 3], "int");
    }

    #[test]
    fn builds_branches_loops_and_terminal_paths() {
        let source = sample();
        let id = inspect(source.clone())[1].id.clone();
        let graph = analyze(source, id, false).unwrap();
        let kinds = graph
            .nodes
            .iter()
            .map(|node| node.kind.as_str())
            .collect::<Vec<_>>();
        assert!(kinds.contains(&"start"));
        assert!(kinds.contains(&"decision"));
        assert!(kinds.contains(&"loop"));
        assert!(kinds.contains(&"continue"));
        assert!(kinds.contains(&"break"));
        assert!(kinds.contains(&"return"));
        assert!(kinds.contains(&"throw"));
        assert!(kinds.contains(&"end"));
        assert!(graph.edges.iter().any(|edge| edge.label == "Yes"));
        assert!(graph.edges.iter().any(|edge| edge.label == "No"));
        assert!(graph.edges.iter().any(|edge| edge.label == "Repeat"));
        assert!(graph.diagnostics.is_empty());
    }

    #[test]
    fn compresses_adjacent_simple_statements() {
        let source = sample();
        let id = inspect(source.clone())[1].id.clone();
        let graph = analyze(source, id, false).unwrap();
        let process = graph
            .nodes
            .iter()
            .find(|node| node.label.contains("int adjusted"))
            .unwrap();
        assert!(process.label.contains("adjusted *= 2"));
    }

    #[test]
    fn comment_toggle_only_changes_comment_payloads() {
        let source = sample();
        let id = inspect(source.clone())[1].id.clone();
        let without = analyze(source.clone(), id.clone(), false).unwrap();
        let with = analyze(source, id, true).unwrap();
        assert_eq!(without.edges, with.edges);
        assert_eq!(without.nodes.len(), with.nodes.len());
        assert!(without.nodes.iter().all(|node| node.comments.is_empty()));
        assert!(without
            .nodes
            .iter()
            .all(|node| !node.label.contains("Normalize")));
        assert!(with.nodes.iter().any(|node| node
            .comments
            .iter()
            .any(|comment| comment.contains("Normalize"))));
        for (left, right) in without.nodes.iter().zip(&with.nodes) {
            assert_eq!(left.id, right.id);
            assert_eq!(left.label, right.label);
            assert_eq!(left.kind, right.kind);
        }
    }

    #[test]
    fn rejects_unknown_function_id() {
        let error = analyze(sample(), "999999".to_owned(), false).unwrap_err();
        assert_eq!(error, "Function not found: 999999");
    }

    #[test]
    fn comments_never_become_flow_nodes_or_code_labels() {
        let source = r#"
void work() {
    // standalone
    int value = /* inline */ 1; // trailing
}
"#
        .to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let without = analyze(source.clone(), id.clone(), false).unwrap();
        let with = analyze(source, id, true).unwrap();
        assert_eq!(without.edges, with.edges);
        assert_eq!(without.nodes.len(), with.nodes.len());
        assert!(without.nodes.iter().all(|node| {
            !node.label.contains("standalone")
                && !node.label.contains("inline")
                && !node.label.contains("trailing")
        }));
        assert_eq!(
            with.nodes
                .iter()
                .map(|node| node.comments.len())
                .sum::<usize>(),
            3
        );
    }

    #[test]
    fn recognizes_cpp_range_for_loops() {
        let source = "void work(auto values) { for (auto value : values) use(value); }".to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        let loop_node = graph
            .nodes
            .iter()
            .find(|node| node.kind == "loop")
            .expect("range for loop node");
        assert!(loop_node.label.contains("auto value : values"));
        assert!(graph.edges.iter().any(|edge| edge.label == "Repeat"));
    }

    #[test]
    fn do_while_enters_body_before_testing_condition() {
        let source = "void work() { do use(); while (ready()); after(); }".to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        let start = graph
            .nodes
            .iter()
            .find(|node| node.kind == "start")
            .unwrap();
        let loop_node = graph.nodes.iter().find(|node| node.kind == "loop").unwrap();
        let body = graph
            .nodes
            .iter()
            .find(|node| node.kind == "process" && node.label == "use()")
            .unwrap();
        assert!(!graph
            .edges
            .iter()
            .any(|edge| edge.source == start.id && edge.target == loop_node.id));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.source == body.id && edge.target == loop_node.id));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.source == loop_node.id && edge.label == "Yes"));
        assert!(graph
            .edges
            .iter()
            .any(|edge| edge.source == loop_node.id && edge.label == "No"));
    }

    #[test]
    fn switch_models_fallthrough_and_default_without_no_match() {
        let source = r#"
void work(int value) {
    switch (value) {
        case 1: value++;
        case 2: value += 2; break;
        default: value = 0;
    }
}
"#
        .to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        let first_body = graph
            .nodes
            .iter()
            .find(|node| node.label == "value++")
            .unwrap();
        let second_case = graph
            .nodes
            .iter()
            .find(|node| node.label == "case 2")
            .unwrap();
        assert!(graph.edges.iter().any(|edge| {
            edge.source == first_body.id
                && edge.target == second_case.id
                && edge.label == "Fallthrough"
        }));
        assert!(graph.edges.iter().any(|edge| edge.label == "default"));
        assert!(!graph.edges.iter().any(|edge| edge.label == "No match"));
    }

    #[test]
    fn diagnostics_include_missing_anonymous_tokens() {
        let source = "void work() { int value = 1;".to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        assert!(graph
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("Missing }")));
    }

    #[test]
    fn refuses_control_flow_that_is_not_modeled() {
        let cases = [
            (
                "void work() { try { use(); } catch (...) { recover(); } }",
                "try/catch",
            ),
            ("void work() { goto done; done: return; }", "goto"),
            ("void work() { done: return; }", "labeled statements"),
            (
                "void work() {\n#if FLAG\nuse();\n#endif\n}",
                "preprocessor conditionals",
            ),
            ("void work() { asm(\"nop\"); }", "inline assembly"),
            ("task work() { co_yield 1; }", "coroutine suspension"),
        ];

        for (source, construct) in cases {
            let source = source.to_owned();
            let id = inspect(source.clone())[0].id.clone();
            let error = analyze(source, id, false).unwrap_err();
            assert!(error.contains(construct), "{error}");
            assert!(error.starts_with("Unsupported control flow at line "));
        }
    }

    #[test]
    fn unsupported_constructs_in_other_functions_do_not_block_analysis() {
        let source = r#"
void risky() { try { use(); } catch (...) { recover(); } }
void safe() { return; }
"#
        .to_owned();
        let functions = inspect(source.clone());
        let graph = analyze(source, functions[1].id.clone(), false).unwrap();
        assert!(graph.nodes.iter().any(|node| node.kind == "return"));
    }

    #[test]
    fn throw_inside_lambda_does_not_terminate_outer_function() {
        let source = r#"
void work() {
    auto action = []() { throw 1; };
    action();
    return;
}
"#
        .to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        assert!(!graph.nodes.iter().any(|node| node.kind == "throw"));
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == "process" && node.label.contains("throw 1")));
        assert!(graph.nodes.iter().any(|node| node.kind == "return"));
    }

    #[test]
    fn coroutine_return_is_terminal() {
        let source = "task work() { co_return 1; }".to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.kind == "return" && node.label == "co_return 1"));
    }

    #[test]
    fn attributed_control_statement_keeps_its_branch() {
        let source = "void work(int value) { [[likely]] if (value) return; use(); }".to_owned();
        let id = inspect(source.clone())[0].id.clone();
        let graph = analyze(source, id, false).unwrap();
        assert!(graph.nodes.iter().any(|node| node.kind == "decision"));
        assert!(graph.nodes.iter().any(|node| node.kind == "return"));
    }
}
