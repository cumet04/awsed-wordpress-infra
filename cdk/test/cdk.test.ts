import {
  expect as expectCDK,
  matchTemplate,
  MatchStyle,
} from "@aws-cdk/assert";
import * as cdk from "@aws-cdk/core";
import * as Cdk from "../lib/cdk-stack";

test("Empty Stack", () => {
  const app = new cdk.App();
  // WHEN
  const env = process.env;
  const stack = new Cdk.CdkStack(app, "MyTestStack", {
    // TODO: tmp params
    albCertArn: env.ALB_CERT_ARN!,
    dbName: "wordpress",
    dbUser: "wordpress",
    amiName: "wordpress",
  });
  // THEN
  expectCDK(stack).to(
    matchTemplate(
      {
        Resources: {},
      },
      MatchStyle.EXACT
    )
  );
});
