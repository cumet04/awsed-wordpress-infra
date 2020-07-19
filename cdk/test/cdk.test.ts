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
    frontCertArn: env.FRONT_CERT_ARN!,
    albDomain: "lb.wordpress.example.com",
    albCertArn: env.ALB_CERT_ARN!,
    albKeyName: "x-alb-pre-shared-key",
    albKeyValue: env.ALB_KEY_VALUE!,
    isOnwerOnly: env.IS_OWNER_ONLY! == "1",
    dbName: "wordpress",
    dbUser: "wordpress",
    amiName: "wordpress",
    ownerIps: env.OWNER_IPS!.split(",").map((s) => s.trim()),
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
