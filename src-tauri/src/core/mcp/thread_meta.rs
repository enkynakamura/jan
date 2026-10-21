// Fork (21/10/2026): call_tool tells the code sandbox which Jan thread a tool call comes from, in the request's `_meta`
// (the MCP field for request-level context), so that it can mount that thread's images (threads/<id>/immagini, see
// core/pasted_images.rs) and only those. With the id goes the folder where Jan keeps its threads, so that the sandbox
// can tell when its own setting points elsewhere (for instance after Jan's data folder was moved) instead of mounting
// stale copies. Both go only with the sandbox's tools (wants_thread_meta) and only to a server on this PC
// (is_local_server): no other tool needs them, and the folder holds the Windows user name.

use rmcp::model::RequestMetaObject;
use serde_json::{Map, Value};
use std::path::Path;

use super::models::extract_command_args;

/// The code sandbox's tools, the only ones that get the thread id and the folder (the sandbox reads them in
/// server.py, _jan_meta). Any other tool gets neither, on a server on this PC too: a local process can still pass on
/// what it receives (a stdio bridge to a remote MCP server, for instance).
const THREAD_META_TOOLS: [&str; 2] = ["run_python_code", "run_javascript_code"];

/// Whether a call to the tool `tool_name` gets the thread's `_meta` (when its server is on this PC).
pub fn wants_thread_meta(tool_name: &str) -> bool {
    THREAD_META_TOOLS.contains(&tool_name)
}

/// The `_meta` key holding the thread id (prefix/name form of the MCP spec). The code sandbox reads the same key.
pub const THREAD_META_KEY: &str = "jan-dev/threadId";

/// The `_meta` key holding the folder where Jan keeps its threads. The code sandbox reads the same key.
pub const THREADS_DIR_META_KEY: &str = "jan-dev/threadsDir";

/// `_meta` carrying `thread_id` and `threads_dir`.
pub fn thread_meta(thread_id: &str, threads_dir: &Path) -> RequestMetaObject {
    let mut meta = Map::new();
    meta.insert(
        THREAD_META_KEY.to_string(),
        Value::String(thread_id.to_string()),
    );
    meta.insert(
        THREADS_DIR_META_KEY.to_string(),
        Value::String(threads_dir.to_string_lossy().into_owned()),
    );
    RequestMetaObject::from(meta)
}

/// Whether the server configured as `config` (its mcp_config.json entry) runs on this PC: a stdio server is a process
/// Jan starts here; an http/sse server counts only when its url's host is loopback (localhost, 127.x.x.x, ::1).
pub fn is_local_server(config: &Value) -> bool {
    let Some(params) = extract_command_args(config) else {
        return false;
    };
    match params.transport_type.as_deref() {
        Some("http" | "sse") => params
            .url
            .as_deref()
            .and_then(|u| url::Url::parse(u).ok())
            .is_some_and(|u| match u.host() {
                Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            }),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::{
        CallToolRequestParams, ClientJsonRpcMessage, ClientRequest, GetMeta, NumberOrString,
        ProgressToken, Request,
    };
    use serde_json::json;

    #[test]
    fn only_the_sandbox_tools_get_the_thread_meta() {
        assert!(wants_thread_meta("run_python_code"));
        assert!(wants_thread_meta("run_javascript_code"));
        for tool in [
            "fetch",
            "search_notes",
            "search_works",
            "Run_Python_Code",
            "run_python_code ",
            "",
        ] {
            assert!(!wants_thread_meta(tool), "{tool:?} gets the thread meta");
        }
    }

    #[test]
    fn stdio_and_loopback_servers_are_local_the_others_are_not() {
        let stdio = json!({"command": "uvx", "args": ["mcp-server-fetch"], "env": {}});
        assert!(is_local_server(&stdio));
        for url in [
            "http://127.0.0.1:8091/mcp",
            "http://localhost:8091/sse",
            "http://LOCALHOST:8091/mcp",
            "http://[::1]:8091/mcp",
            "http://127.0.0.2:9000/mcp",
        ] {
            assert!(
                is_local_server(&json!({"type": "http", "url": url})),
                "{url} is local"
            );
            assert!(
                is_local_server(&json!({"type": "sse", "url": url})),
                "{url} is local (sse)"
            );
        }
        for url in [
            "https://mcp.tavily.com/mcp/",
            "https://arxiv.caseyjhand.com/mcp",
            "http://192.168.1.10:8091/mcp",
            "http://localhost.example.com/mcp",
            "not a url",
        ] {
            assert!(
                !is_local_server(&json!({"type": "http", "url": url})),
                "{url} is not local"
            );
        }
        assert!(
            !is_local_server(&json!({"type": "http"})),
            "an http server without url is not local"
        );
    }

    /// The id and the folder must reach the wire in `params._meta`, next to the progress token rmcp adds to every
    /// request before sending it (service.rs: `request.get_meta_mut().set_progress_token(..)`).
    #[test]
    fn the_thread_id_and_folder_are_serialized_in_the_request_meta() {
        let threads_dir = Path::new("C:\\Users\\Enky\\AppData\\Roaming\\Jan\\data\\threads");
        let mut params = CallToolRequestParams::new("run_python_code")
            .with_arguments(json!({"code": "print(1)"}).as_object().unwrap().clone());
        params.meta = Some(thread_meta(
            "72119d07-1403-4ab3-ba4f-14db831ad87d",
            threads_dir,
        ));
        let mut request = ClientRequest::CallToolRequest(Request::new(params));
        request
            .get_meta_mut()
            .set_progress_token(ProgressToken(NumberOrString::Number(7)));
        let message = ClientJsonRpcMessage::request(request, NumberOrString::Number(1));
        let wire = serde_json::to_value(&message).unwrap();
        assert_eq!(wire["method"], "tools/call");
        assert_eq!(wire["params"]["name"], "run_python_code");
        assert_eq!(wire["params"]["arguments"]["code"], "print(1)");
        assert_eq!(
            wire["params"]["_meta"][THREAD_META_KEY],
            "72119d07-1403-4ab3-ba4f-14db831ad87d"
        );
        assert_eq!(
            wire["params"]["_meta"][THREADS_DIR_META_KEY],
            "C:\\Users\\Enky\\AppData\\Roaming\\Jan\\data\\threads"
        );
        assert_eq!(wire["params"]["_meta"]["progressToken"], 7);
    }
}
