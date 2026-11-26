// A bare undeclared identifier is rejected by AstGen even inside a comptime-false branch.
const flag = false;
pub fn main() void {
    if (comptime flag) bootBunShell();
}
