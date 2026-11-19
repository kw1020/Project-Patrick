import { redirect } from "next/navigation";

/** v1.9.5: the page was renamed Upload (Krew: "an upload page next to the queue"); old links still work. */
export default function ToPostRedirect() {
  redirect("/upload");
}
