import { Layout } from "./layout";
import { ActionRow, Button, PageHeader, Panel } from "./ui";

export function MessagePage(props: { title: string; message: string; user?: { id: number; isAdmin: boolean } | null }) {
  return (
    <Layout title={props.title} user={props.user}>
      <PageHeader title={props.title} />
      <Panel>
        <p>{props.message}</p>
        <ActionRow>
          <Button href="/">Back to start</Button>
        </ActionRow>
      </Panel>
    </Layout>
  );
}
